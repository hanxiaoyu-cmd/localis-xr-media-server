package com.localis.xrplayer.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

interface CookiePersistence {
    fun load(): List<StoredCookie>
    fun save(cookies: List<StoredCookie>)
}

@Serializable
data class StoredCookie(
    val origin: String,
    val name: String,
    val value: String,
    val expiresAt: Long,
    val domain: String,
    val path: String,
    val secure: Boolean,
    val httpOnly: Boolean,
    val hostOnly: Boolean,
) {
    fun toCookie(): Cookie? = runCatching {
        val stored = this
        Cookie.Builder()
            .name(stored.name)
            .value(stored.value)
            .expiresAt(stored.expiresAt)
            .path(stored.path)
            .apply {
                if (stored.hostOnly) hostOnlyDomain(stored.domain) else domain(stored.domain)
                if (stored.secure) secure()
                if (stored.httpOnly) httpOnly()
            }
            .build()
    }.getOrNull()

    companion object {
        fun from(cookie: Cookie, origin: String) = StoredCookie(
            origin = origin,
            name = cookie.name,
            value = cookie.value,
            expiresAt = cookie.expiresAt,
            domain = cookie.domain,
            path = cookie.path,
            secure = cookie.secure,
            httpOnly = cookie.httpOnly,
            hostOnly = cookie.hostOnly,
        )
    }
}

class PreferencesCookiePersistence(context: Context) : CookiePersistence {
    private val preferences = context.getSharedPreferences("localis_cookies", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    override fun load(): List<StoredCookie> = runCatching {
        val encoded = preferences.getString(KEY_COOKIES, null) ?: return emptyList()
        val payload = Base64.decode(encoded, Base64.NO_WRAP)
        require(payload.size > IV_BYTES)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), GCMParameterSpec(128, payload.copyOfRange(0, IV_BYTES)))
        val plaintext = cipher.doFinal(payload, IV_BYTES, payload.size - IV_BYTES)
        json.decodeFromString<List<StoredCookie>>(String(plaintext, Charsets.UTF_8))
    }.getOrDefault(emptyList())

    override fun save(cookies: List<StoredCookie>) {
        if (cookies.isEmpty()) {
            preferences.edit().remove(KEY_COOKIES).apply()
            return
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        val ciphertext = cipher.doFinal(json.encodeToString(cookies).toByteArray(Charsets.UTF_8))
        val payload = cipher.iv + ciphertext
        preferences.edit().putString(KEY_COOKIES, Base64.encodeToString(payload, Base64.NO_WRAP)).apply()
    }

    private fun encryptionKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    }

    companion object {
        private const val KEY_COOKIES = "cookies"
        private const val KEY_ALIAS = "localis_android_session_v1"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
    }
}

class PersistentCookieJar(private val persistence: CookiePersistence) : CookieJar {
    private data class BoundCookie(val origin: String, val cookie: Cookie)

    private val cookies = linkedMapOf<String, BoundCookie>()

    init {
        val now = System.currentTimeMillis()
        persistence.load().mapNotNull { stored ->
            stored.toCookie()?.let { cookie -> BoundCookie(stored.origin, cookie) }
        }
            .filter { it.cookie.expiresAt > now }
            .forEach { cookies[key(it.origin, it.cookie)] = it }
        persist()
    }

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val now = System.currentTimeMillis()
        val origin = ServerAddress.origin(url)
        cookies.forEach { cookie ->
            val key = key(origin, cookie)
            if (cookie.expiresAt <= now) this.cookies.remove(key)
            else this.cookies[key] = BoundCookie(origin, cookie)
        }
        removeExpired(now)
        persist()
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        if (removeExpired(System.currentTimeMillis())) persist()
        val origin = ServerAddress.origin(url)
        return cookies.values
            .filter { it.origin == origin && it.cookie.matches(url) }
            .map(BoundCookie::cookie)
    }

    @Synchronized
    fun clear() {
        cookies.clear()
        persist()
    }

    private fun removeExpired(now: Long): Boolean {
        val expired = cookies.filterValues { it.cookie.expiresAt <= now }.keys
        expired.forEach(cookies::remove)
        return expired.isNotEmpty()
    }

    private fun persist() = persistence.save(cookies.values.map { StoredCookie.from(it.cookie, it.origin) })

    private fun key(origin: String, cookie: Cookie) = "$origin|${cookie.domain}|${cookie.path}|${cookie.name}"
}
