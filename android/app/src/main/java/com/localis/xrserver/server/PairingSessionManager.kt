package com.localis.xrserver.server

import java.security.SecureRandom
import java.util.Base64
import kotlin.math.ceil

sealed interface PairingResult {
    data class Success(val token: String, val maxAgeSeconds: Int) : PairingResult
    data class Invalid(val attemptsRemaining: Int) : PairingResult
    data class RateLimited(val retryAfterSeconds: Int) : PairingResult
}

/** In-memory pairing sessions. Stopping the server invalidates every token. */
class PairingSessionManager(
    private val clock: () -> Long = System::currentTimeMillis,
    private val pairingCodeFactory: () -> String = ::randomPairingCode,
    private val tokenFactory: () -> String = ::randomSessionToken,
    private val sessionLifetimeMillis: Long = DEFAULT_SESSION_LIFETIME_MILLIS,
    private val attemptWindowMillis: Long = DEFAULT_ATTEMPT_WINDOW_MILLIS,
    private val maxAttemptsPerAddress: Int = DEFAULT_MAX_ATTEMPTS_PER_ADDRESS,
    private val maxGlobalAttempts: Int = DEFAULT_MAX_GLOBAL_ATTEMPTS,
    private val maxSessions: Int = DEFAULT_MAX_SESSIONS,
) {
    private data class AttemptWindow(var count: Int, val resetAt: Long)

    private val sessions = linkedMapOf<String, Long>()
    private val attempts = mutableMapOf<String, AttemptWindow>()
    private var globalAttempts = AttemptWindow(0, 0)

    init {
        require(maxSessions in 1..MAX_SESSION_LIMIT)
    }

    @Volatile
    var pairingCode: String = checkedCode(pairingCodeFactory())
        private set

    @Synchronized
    fun startNewEpoch() {
        invalidateAll()
        pairingCode = checkedCode(pairingCodeFactory())
    }

    @Synchronized
    fun invalidateAll() {
        sessions.clear()
        attempts.clear()
        globalAttempts = AttemptWindow(0, 0)
    }

    @Synchronized
    fun authenticate(cookieHeader: String?): Boolean {
        val token = cookieHeader?.split(';')
            ?.asSequence()
            ?.map(String::trim)
            ?.mapNotNull { entry ->
                val separator = entry.indexOf('=')
                if (separator <= 0) null else entry.substring(0, separator) to entry.substring(separator + 1)
            }
            ?.firstOrNull { it.first == COOKIE_NAME }
            ?.second
            ?: return false
        val now = clock()
        removeExpiredSessions(now)
        return sessions[token]?.let { it > now } == true
    }

    @Synchronized
    fun verify(code: String, remoteAddress: String): PairingResult {
        val now = clock()
        removeExpiredSessions(now)
        if (globalAttempts.resetAt <= now) {
            globalAttempts = AttemptWindow(0, now + attemptWindowMillis)
        }
        if (globalAttempts.count >= maxGlobalAttempts) {
            return PairingResult.RateLimited(secondsUntil(globalAttempts.resetAt, now))
        }

        val known = attempts[remoteAddress]
        val addressWindow = if (known == null || known.resetAt <= now) {
            AttemptWindow(0, now + attemptWindowMillis).also { attempts[remoteAddress] = it }
        } else {
            known
        }
        if (addressWindow.count >= maxAttemptsPerAddress) {
            return PairingResult.RateLimited(secondsUntil(addressWindow.resetAt, now))
        }
        addressWindow.count += 1

        if (code != pairingCode) {
            globalAttempts.count += 1
            trimAttemptMap(now)
            return PairingResult.Invalid((maxAttemptsPerAddress - addressWindow.count).coerceAtLeast(0))
        }

        attempts.remove(remoteAddress)
        val token = tokenFactory()
        require(token.isNotBlank() && token.none { it <= ' ' || it == ';' || it == ',' }) {
            "Session token factory returned an invalid token"
        }
        sessions.remove(token)
        while (sessions.size >= maxSessions) {
            val oldest = sessions.minByOrNull { it.value }?.key ?: break
            sessions.remove(oldest)
        }
        sessions[token] = now + sessionLifetimeMillis
        return PairingResult.Success(
            token = token,
            maxAgeSeconds = (sessionLifetimeMillis / 1_000).coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
        )
    }

    private fun removeExpiredSessions(now: Long) {
        sessions.entries.removeIf { it.value <= now }
    }

    private fun trimAttemptMap(now: Long) {
        if (attempts.size <= MAX_TRACKED_ADDRESSES) return
        attempts.entries.removeIf { it.value.resetAt <= now }
        while (attempts.size > MAX_TRACKED_ADDRESSES) {
            val oldest = attempts.minByOrNull { it.value.resetAt }?.key ?: break
            attempts.remove(oldest)
        }
    }

    private fun secondsUntil(deadline: Long, now: Long): Int =
        ceil((deadline - now).coerceAtLeast(1) / 1_000.0).toInt().coerceAtLeast(1)

    private fun checkedCode(value: String): String {
        require(PAIRING_CODE.matches(value)) { "Pairing code must contain exactly six digits" }
        return value
    }

    companion object {
        const val COOKIE_NAME = "localis_session"
        private const val DEFAULT_SESSION_LIFETIME_MILLIS = 30L * 24 * 60 * 60 * 1_000
        private const val DEFAULT_ATTEMPT_WINDOW_MILLIS = 5L * 60 * 1_000
        private const val DEFAULT_MAX_ATTEMPTS_PER_ADDRESS = 5
        private const val DEFAULT_MAX_GLOBAL_ATTEMPTS = 50
        private const val DEFAULT_MAX_SESSIONS = 128
        private const val MAX_SESSION_LIMIT = 4_096
        private const val MAX_TRACKED_ADDRESSES = 256
        private val PAIRING_CODE = Regex("^\\d{6}$")

        private val random = SecureRandom()

        private fun randomPairingCode(): String = (100_000 + random.nextInt(900_000)).toString()

        private fun randomSessionToken(): String {
            val bytes = ByteArray(32)
            random.nextBytes(bytes)
            return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        }
    }
}
