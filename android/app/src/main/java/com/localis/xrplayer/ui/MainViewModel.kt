package com.localis.xrplayer.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.localis.xrplayer.data.LibraryResponse
import com.localis.xrplayer.data.LocalisApi
import com.localis.xrplayer.data.LocalisApiException
import com.localis.xrplayer.data.PlaybackProgress
import com.localis.xrplayer.data.PlaybackSources
import com.localis.xrplayer.data.PublicMediaItem
import com.localis.xrplayer.data.ServerAddress
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl

enum class ConnectionStage { DISCONNECTED, CONNECTING, PAIRING, READY }

data class MainUiState(
    val address: String = "",
    val stage: ConnectionStage = ConnectionStage.DISCONNECTED,
    val items: List<PublicMediaItem> = emptyList(),
    val progress: Map<String, PlaybackProgress> = emptyMap(),
    val selectedItem: PublicMediaItem? = null,
    val selectedSources: PlaybackSources? = null,
    val error: String? = null,
    val refreshing: Boolean = false,
)

class MainViewModel(private val api: LocalisApi) : ViewModel() {
    private val _uiState = MutableStateFlow(
        MainUiState(address = api.configuredOrigin()?.let(ServerAddress::origin).orEmpty()),
    )
    val uiState: StateFlow<MainUiState> = _uiState.asStateFlow()

    private var connectJob: Job? = null
    private var refreshJob: Job? = null
    private var serverGeneration = 0L
    private val progressWriteMutex = Mutex()

    init {
        if (_uiState.value.address.isNotEmpty()) connect(_uiState.value.address)
    }

    fun updateAddress(value: String) {
        _uiState.update { it.copy(address = value, error = null) }
    }

    fun connect(address: String = _uiState.value.address) {
        val generation = advanceServerGeneration()
        connectJob = viewModelScope.launch {
            _uiState.update { it.copy(address = address, stage = ConnectionStage.CONNECTING, error = null) }
            val result = runCatchingCancellable {
                api.configure(address)
                val health = api.health()
                require(health.ok && health.service == "localis") { "目标地址不是 Localis 服务器" }
                api.pairStatus()
            }
            if (generation != serverGeneration) return@launch
            result.onSuccess { status ->
                if (status.paired) loadLibraryInternal(generation) else {
                    _uiState.update { it.copy(stage = ConnectionStage.PAIRING, error = null) }
                }
            }.onFailure(::showFailure)
        }
    }

    fun verifyPairing(code: String) {
        if (!code.matches(Regex("\\d{6}"))) {
            _uiState.update { it.copy(error = "请输入电脑端显示的六位配对码") }
            return
        }
        val generation = serverGeneration
        connectJob?.cancel()
        connectJob = viewModelScope.launch {
            _uiState.update { it.copy(stage = ConnectionStage.CONNECTING, error = null) }
            val result = runCatchingCancellable { api.verifyPairing(code) }
            if (generation != serverGeneration) return@launch
            result
                .onSuccess { result ->
                    if (result.paired) loadLibraryInternal(generation)
                    else showFailure(IOException("配对未完成"))
                }
                .onFailure(::showFailure)
        }
    }

    fun refresh() {
        if (_uiState.value.stage != ConnectionStage.READY || _uiState.value.refreshing) return
        val generation = serverGeneration
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch {
            _uiState.update { it.copy(refreshing = true, error = null) }
            val result = runCatchingCancellable { api.library() }
            if (generation != serverGeneration) return@launch
            result
                .onSuccess(::applyLibrary)
                .onFailure(::showFailure)
            _uiState.update { it.copy(refreshing = false) }
        }
    }

    fun select(item: PublicMediaItem) {
        runCatching { api.playbackSources(item) }
            .onSuccess { sources ->
                _uiState.update { it.copy(selectedItem = item, selectedSources = sources, error = null) }
            }
            .onFailure { error ->
                _uiState.update { it.copy(error = error.message ?: "该媒体的播放地址无效") }
            }
    }

    fun closePlayer() {
        _uiState.update { it.copy(selectedItem = null, selectedSources = null) }
    }

    fun editServer() {
        advanceServerGeneration()
        _uiState.update {
            it.copy(
                stage = ConnectionStage.DISCONNECTED,
                selectedItem = null,
                selectedSources = null,
                refreshing = false,
                error = null,
            )
        }
    }

    suspend fun awaitCompatibility(mediaId: String): HttpUrl = api.awaitCompatibilityManifest(mediaId)

    fun saveProgress(item: PublicMediaItem, positionMs: Long, durationMs: Long) {
        if (positionMs < 0) return
        val generation = serverGeneration
        val safeDuration = durationMs.takeIf { it > 0 } ?: (item.duration * 1_000).toLong()
        viewModelScope.launch {
            runCatchingCancellable {
                progressWriteMutex.withLock {
                    if (generation != serverGeneration) null
                    else api.saveProgress(
                            mediaId = item.id,
                            positionSeconds = positionMs / 1_000.0,
                            durationSeconds = safeDuration.coerceAtLeast(0) / 1_000.0,
                        )
                }
            }.onSuccess { saved ->
                if (saved != null && generation == serverGeneration) {
                    _uiState.update { current -> current.copy(progress = current.progress + (item.id to saved)) }
                }
            }
        }
    }

    fun clearError() {
        _uiState.update { it.copy(error = null) }
    }

    fun requirePairing() {
        _uiState.update {
            it.copy(
                stage = ConnectionStage.PAIRING,
                selectedItem = null,
                selectedSources = null,
                error = "会话已失效，请重新配对",
            )
        }
    }

    private suspend fun loadLibraryInternal(generation: Long) {
        val result = runCatchingCancellable { api.library() }
        if (generation != serverGeneration) return
        result
            .onSuccess(::applyLibrary)
            .onFailure(::showFailure)
    }

    private fun advanceServerGeneration(): Long {
        serverGeneration += 1
        connectJob?.cancel()
        refreshJob?.cancel()
        return serverGeneration
    }

    private fun applyLibrary(library: LibraryResponse) {
        _uiState.update {
            it.copy(
                stage = ConnectionStage.READY,
                items = library.items.filter { item -> item.kind == "video" || item.kind == "audio" },
                progress = library.progress,
                error = null,
                refreshing = false,
            )
        }
    }

    private fun showFailure(cause: Throwable) {
        val pairingExpired = cause is LocalisApiException && cause.status == 401
        val pairingError = cause is LocalisApiException && cause.code in setOf("invalid_pairing_code", "too_many_attempts")
        val message = when {
            cause is LocalisApiException && cause.code == "invalid_pairing_code" -> "配对码不正确"
            cause is LocalisApiException && cause.code == "too_many_attempts" -> "尝试次数过多，请稍后再试"
            pairingExpired -> "会话已失效，请重新配对"
            cause.message.isNullOrBlank() -> "无法连接 Localis 服务器"
            else -> cause.message.orEmpty()
        }
        _uiState.update {
            it.copy(
                stage = when {
                    pairingExpired || pairingError -> ConnectionStage.PAIRING
                    it.stage == ConnectionStage.READY -> ConnectionStage.READY
                    else -> ConnectionStage.DISCONNECTED
                },
                error = message,
                refreshing = false,
            )
        }
    }

    class Factory(private val api: LocalisApi) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = MainViewModel(api) as T
    }
}

private suspend inline fun <T> runCatchingCancellable(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (error: Throwable) {
    Result.failure(error)
}
