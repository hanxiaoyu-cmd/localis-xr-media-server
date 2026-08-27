package com.localis.xrserver.service

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

enum class ServerPhase { STOPPED, STARTING, RUNNING, STOPPING, ERROR }

data class ServerRuntimeState(
    val phase: ServerPhase = ServerPhase.STOPPED,
    val urls: List<String> = emptyList(),
    val pairingCode: String? = null,
    val error: String? = null,
) {
    val running: Boolean get() = phase == ServerPhase.RUNNING
    val busy: Boolean get() = phase == ServerPhase.STARTING || phase == ServerPhase.STOPPING
}

class ServerRuntimeStore {
    private val _state = MutableStateFlow(ServerRuntimeState())
    val state: StateFlow<ServerRuntimeState> = _state.asStateFlow()

    fun update(transform: (ServerRuntimeState) -> ServerRuntimeState) = _state.update(transform)

    fun set(value: ServerRuntimeState) {
        _state.value = value
    }
}
