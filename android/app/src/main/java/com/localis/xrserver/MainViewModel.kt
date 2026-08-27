package com.localis.xrserver

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.localis.xrserver.data.MediaFolderState
import com.localis.xrserver.service.MediaServerService
import com.localis.xrserver.service.ServerRuntimeState
import com.localis.xrserver.service.ServerSettings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class MainUiState(
    val folder: MediaFolderState = MediaFolderState(),
    val server: ServerRuntimeState = ServerRuntimeState(),
    val settings: ServerSettings = ServerSettings(),
    val actionError: String? = null,
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val container = (application as LocalisApplication).container
    private val actionError = MutableStateFlow<String?>(null)

    val uiState = combine(
        container.mediaRepository.state,
        container.serverRuntime.state,
        actionError,
        container.serverSettings.state,
    ) { folder, server, error, settings ->
        MainUiState(folder = folder, server = server, settings = settings, actionError = error)
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = MainUiState(
            folder = container.mediaRepository.state.value,
            server = container.serverRuntime.state.value,
            settings = container.serverSettings.state.value,
        ),
    )

    init {
        if (container.mediaRepository.selectedTreeUri() != null) refreshLibrary()
    }

    fun selectFolder(uri: Uri) = runRepositoryAction {
        container.mediaRepository.selectFolder(uri)
    }

    fun refreshLibrary() = runRepositoryAction {
        container.mediaRepository.refresh()
    }

    fun clearFolder() = runRepositoryAction {
        container.mediaRepository.clearFolder()
    }

    fun startServer() {
        actionError.value = null
        MediaServerService.start(getApplication())
    }

    fun stopServer() {
        actionError.value = null
        MediaServerService.stop(getApplication())
    }

    fun selectedTreeUri(): Uri? = container.mediaRepository.selectedTreeUri()

    fun updatePort(value: String) {
        container.serverSettings.updatePortText(value)
    }

    fun updateExternalOrigin(value: String) {
        container.serverSettings.updateExternalOriginText(value)
    }

    private fun runRepositoryAction(block: suspend () -> Unit) {
        viewModelScope.launch {
            actionError.value = null
            try {
                block()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                actionError.value = error.message ?: "操作失败，请重试。"
            }
        }
    }
}
