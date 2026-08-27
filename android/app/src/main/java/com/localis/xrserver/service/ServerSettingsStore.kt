package com.localis.xrserver.service

import android.content.Context
import androidx.core.content.edit
import com.localis.xrserver.server.RequestSecurity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class ServerSettings(
    val portText: String = DEFAULT_PORT.toString(),
    val externalOriginText: String = "",
) {
    fun resolve(): ResolvedServerSettings {
        val port = portText.toIntOrNull()?.takeIf { it in MIN_PORT..65_535 }
            ?: throw IllegalArgumentException("端口必须是 $MIN_PORT–65535 之间的数字。")
        val candidate = externalOriginText.trim().let { value ->
            if (value.endsWith('/') && value.count { it == '/' } == 3) value.dropLast(1) else value
        }
        if (candidate.isEmpty()) return ResolvedServerSettings(port = port, externalOrigin = null)
        val origin = RequestSecurity.parseOrigin(candidate)
            ?.takeIf { it.scheme == "https" }
            ?: throw IllegalArgumentException("可信外部来源必须是不带路径、参数或账号信息的 HTTPS 来源。")
        return ResolvedServerSettings(port = port, externalOrigin = origin.render())
    }

    fun validationError(): String? = runCatching(::resolve).exceptionOrNull()?.message

    companion object {
        const val DEFAULT_PORT = 8_081
        const val MIN_PORT = 1_024
    }
}

data class ResolvedServerSettings(
    val port: Int,
    val externalOrigin: String?,
)

class ServerSettingsStore(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val _state = MutableStateFlow(
        ServerSettings(
            portText = preferences.getString(KEY_PORT, null) ?: ServerSettings.DEFAULT_PORT.toString(),
            externalOriginText = preferences.getString(KEY_EXTERNAL_ORIGIN, null).orEmpty(),
        ),
    )
    val state: StateFlow<ServerSettings> = _state.asStateFlow()

    fun updatePortText(value: String) {
        val normalized = value.filter(Char::isDigit).take(5)
        update(_state.value.copy(portText = normalized))
    }

    fun updateExternalOriginText(value: String) {
        update(_state.value.copy(externalOriginText = value.take(MAX_ORIGIN_CHARS)))
    }

    fun resolved(): ResolvedServerSettings = _state.value.resolve()

    private fun update(value: ServerSettings) {
        _state.value = value
        preferences.edit {
            putString(KEY_PORT, value.portText)
            putString(KEY_EXTERNAL_ORIGIN, value.externalOriginText)
        }
    }

    private companion object {
        const val PREFERENCES = "localis_server_settings"
        const val KEY_PORT = "listener_port"
        const val KEY_EXTERNAL_ORIGIN = "external_https_origin"
        const val MAX_ORIGIN_CHARS = 255
    }
}
