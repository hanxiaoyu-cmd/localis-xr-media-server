package com.localis.xrplayer.data

import android.content.Context
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

interface ServerOriginStore {
    fun get(): HttpUrl?
    fun set(value: HttpUrl)
}

class PreferencesServerOriginStore(context: Context) : ServerOriginStore {
    private val preferences = context.getSharedPreferences("localis_server", Context.MODE_PRIVATE)

    @Volatile
    private var cached = preferences.getString(KEY_ORIGIN, null)?.toHttpUrlOrNull()

    override fun get(): HttpUrl? = cached

    override fun set(value: HttpUrl) {
        cached = value
        preferences.edit().putString(KEY_ORIGIN, value.toString()).apply()
    }

    companion object {
        private const val KEY_ORIGIN = "server_origin"
    }
}
