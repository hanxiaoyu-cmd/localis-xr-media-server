package com.localis.xrplayer.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.datasource.DataSource
import com.localis.xrplayer.data.PlaybackProgress
import com.localis.xrplayer.data.PublicMediaItem

private enum class LibraryFilter { ALL, VIDEO, AUDIO }

@Composable
fun LocalisApp(
    viewModel: MainViewModel,
    mediaDataSourceFactory: DataSource.Factory,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val selected = state.selectedItem
    val selectedSources = state.selectedSources
    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (selected != null && selectedSources != null) {
            PlayerScreen(
                item = selected,
                savedProgress = state.progress[selected.id],
                sources = selectedSources,
                mediaDataSourceFactory = mediaDataSourceFactory,
                awaitCompatibility = { viewModel.awaitCompatibility(selected.id) },
                saveProgress = { position, duration -> viewModel.saveProgress(selected, position, duration) },
                onPairingRequired = viewModel::requirePairing,
                onBack = viewModel::closePlayer,
            )
        } else if (state.stage == ConnectionStage.READY) {
            LibraryScreen(
                state = state,
                onRefresh = viewModel::refresh,
                onEditServer = viewModel::editServer,
                onSelect = viewModel::select,
            )
        } else {
            ConnectScreen(
                state = state,
                onAddressChanged = viewModel::updateAddress,
                onConnect = { viewModel.connect() },
                onPair = viewModel::verifyPairing,
                onEditServer = viewModel::editServer,
            )
        }
    }
}

@Composable
private fun ConnectScreen(
    state: MainUiState,
    onAddressChanged: (String) -> Unit,
    onConnect: () -> Unit,
    onPair: (String) -> Unit,
    onEditServer: () -> Unit,
) {
    var pairingCode by rememberSaveable { mutableStateOf("") }
    val busy = state.stage == ConnectionStage.CONNECTING
    Box(
        modifier = Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Card(
            modifier = Modifier.fillMaxWidth().widthIn(max = 720.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(modifier = Modifier.padding(28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("Localis Player", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text(
                    if (state.stage == ConnectionStage.PAIRING) "输入电脑端本次启动显示的配对码"
                    else "连接同一局域网中的 Localis 服务器",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                if (state.stage == ConnectionStage.PAIRING) {
                    Text("服务器：${state.address}", style = MaterialTheme.typography.bodyMedium)
                    OutlinedTextField(
                        value = pairingCode,
                        onValueChange = { pairingCode = it.filter(Char::isDigit).take(6) },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("配对码") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { if (pairingCode.length == 6) onPair(pairingCode) }),
                        enabled = !busy,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Button(onClick = { onPair(pairingCode) }, enabled = !busy && pairingCode.length == 6) { Text("配对") }
                        TextButton(onClick = onEditServer, enabled = !busy) { Text("修改地址") }
                    }
                } else {
                    OutlinedTextField(
                        value = state.address,
                        onValueChange = onAddressChanged,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("服务器地址") },
                        placeholder = { Text("192.168.1.100:8081") },
                        supportingText = { Text("私有局域网可用 HTTP；公网地址必须使用 HTTPS") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { onConnect() }),
                        enabled = !busy,
                    )
                    Button(onClick = onConnect, enabled = !busy && state.address.isNotBlank()) {
                        Text("连接服务器")
                    }
                }

                if (busy) Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(modifier = Modifier.width(22.dp).height(22.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(12.dp))
                    Text("正在连接…")
                }
                state.error?.let { ErrorMessage(it) }
                Text(
                    "Beta 版本不会自动发现服务器，请手动输入电脑端显示的局域网地址。HTTP 流量未加密。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun LibraryScreen(
    state: MainUiState,
    onRefresh: () -> Unit,
    onEditServer: () -> Unit,
    onSelect: (PublicMediaItem) -> Unit,
) {
    var filter by rememberSaveable { mutableStateOf(LibraryFilter.ALL) }
    val visibleItems = remember(state.items, filter) {
        state.items.filter {
            filter == LibraryFilter.ALL ||
                (filter == LibraryFilter.VIDEO && it.kind == "video") ||
                (filter == LibraryFilter.AUDIO && it.kind == "audio")
        }
    }

    Column(modifier = Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("媒体库", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(state.address, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            OutlinedButton(onClick = onEditServer) { Text("服务器") }
            Spacer(Modifier.width(10.dp))
            Button(onClick = onRefresh, enabled = !state.refreshing) {
                Text(if (state.refreshing) "刷新中…" else "刷新")
            }
        }
        Row(
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            FilterChip(selected = filter == LibraryFilter.ALL, onClick = { filter = LibraryFilter.ALL }, label = { Text("全部") })
            FilterChip(selected = filter == LibraryFilter.VIDEO, onClick = { filter = LibraryFilter.VIDEO }, label = { Text("视频") })
            FilterChip(selected = filter == LibraryFilter.AUDIO, onClick = { filter = LibraryFilter.AUDIO }, label = { Text("音频") })
        }
        state.error?.let { Box(Modifier.padding(horizontal = 24.dp, vertical = 8.dp)) { ErrorMessage(it) } }
        HorizontalDivider()
        if (visibleItems.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("媒体库暂无${if (filter == LibraryFilter.AUDIO) "音频" else if (filter == LibraryFilter.VIDEO) "视频" else "内容"}")
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(visibleItems, key = { it.id }) { item ->
                    MediaRow(item, state.progress[item.id], onClick = { onSelect(item) })
                }
            }
        }
    }
}

@Composable
private fun MediaRow(item: PublicMediaItem, progress: PlaybackProgress?, onClick: () -> Unit) {
    val progressFraction = if (progress != null && progress.duration > 0) {
        (progress.position / progress.duration).toFloat().coerceIn(0f, 1f)
    } else 0f
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                modifier = Modifier.width(72.dp).height(48.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
                shape = MaterialTheme.shapes.medium,
            ) {
                Box(contentAlignment = Alignment.Center) { Text(if (item.kind == "audio") "AUDIO" else "VIDEO") }
            }
            Spacer(Modifier.width(16.dp))
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
                Text(mediaDescription(item), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (progressFraction > 0f) {
                    androidx.compose.material3.LinearProgressIndicator(
                        progress = { progressFraction },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            Spacer(Modifier.width(16.dp))
            Text(if (progressFraction > 0f) "继续 ${formatDuration(progress?.position ?: 0.0)}" else formatDuration(item.duration))
        }
    }
}

@Composable
private fun ErrorMessage(message: String) {
    Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
}

private fun mediaDescription(item: PublicMediaItem): String {
    val shape = when (item.projection) {
        "equirect180" -> "VR180 ${item.stereo.uppercase()}"
        "equirect360" -> "360° ${item.stereo.uppercase()}"
        else -> if (item.kind == "audio") "音频" else "平面视频"
    }
    val resolution = if (item.width != null && item.height != null) "${item.width}×${item.height}" else null
    val codec = item.videoCodec ?: item.audioCodec ?: item.extension.trimStart('.').uppercase()
    return listOfNotNull(shape, resolution, codec.takeIf(String::isNotBlank), formatBytes(item.size)).joinToString(" · ")
}

private fun formatDuration(seconds: Double): String {
    if (!seconds.isFinite() || seconds <= 0) return "—"
    val total = seconds.toLong()
    val hours = total / 3_600
    val minutes = (total % 3_600) / 60
    val remainder = total % 60
    return if (hours > 0) "%d:%02d:%02d".format(hours, minutes, remainder) else "%d:%02d".format(minutes, remainder)
}

private fun formatBytes(bytes: Long): String {
    if (bytes <= 0) return "未知大小"
    val gib = bytes / (1024.0 * 1024.0 * 1024.0)
    return if (gib >= 1) "%.1f GB".format(gib) else "%.0f MB".format(bytes / (1024.0 * 1024.0))
}
