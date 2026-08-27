package com.localis.xrserver

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.localis.xrserver.service.ServerPhase
import com.localis.xrserver.ui.theme.LocalisTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            LocalisTheme {
                val viewModel: MainViewModel = viewModel()
                val uiState by viewModel.uiState.collectAsStateWithLifecycle()
                val folderPicker = rememberLauncherForActivityResult(
                    ActivityResultContracts.OpenDocumentTree(),
                ) { uri ->
                    uri?.let(viewModel::selectFolder)
                }
                val notificationPermission = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission(),
                ) {
                    // Notification permission affects drawer visibility, not
                    // the user's explicit request to start the foreground job.
                    viewModel.startServer()
                }
                val startServer = {
                    if (
                        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                        ContextCompat.checkSelfPermission(
                            this,
                            Manifest.permission.POST_NOTIFICATIONS,
                        ) != PackageManager.PERMISSION_GRANTED
                    ) {
                        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    } else {
                        viewModel.startServer()
                    }
                }
                ServerManagerScreen(
                    state = uiState,
                    onChooseFolder = { folderPicker.launch(viewModel.selectedTreeUri()) },
                    onRefresh = viewModel::refreshLibrary,
                    onClearFolder = viewModel::clearFolder,
                    onStart = startServer,
                    onStop = viewModel::stopServer,
                    onPortChange = viewModel::updatePort,
                    onExternalOriginChange = viewModel::updateExternalOrigin,
                )
            }
        }
    }
}

@Composable
private fun ServerManagerScreen(
    state: MainUiState,
    onChooseFolder: () -> Unit,
    onRefresh: () -> Unit,
    onClearFolder: () -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onPortChange: (String) -> Unit,
    onExternalOriginChange: (String) -> Unit,
) {
    Surface(modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item {
                Spacer(Modifier.height(12.dp))
                Text(
                    text = "Localis XR Server",
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    text = "让头显浏览器直接访问手机中的原片",
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            item {
                ServerCard(
                    state = state,
                    onStart = onStart,
                    onStop = onStop,
                    onPortChange = onPortChange,
                    onExternalOriginChange = onExternalOriginChange,
                )
            }

            item {
                LibraryCard(
                    state = state,
                    onChooseFolder = onChooseFolder,
                    onRefresh = onRefresh,
                    onClearFolder = onClearFolder,
                )
            }

            if (state.folder.media.isNotEmpty()) {
                item {
                    Text(
                        text = "最近索引的媒体",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                items(state.folder.media.take(5), key = { it.item.id }) { record ->
                    MediaRow(
                        title = record.item.title,
                        detail = listOf(
                            projectionLabel(record.item.projection),
                            record.item.stereo.uppercase(),
                            formatBytes(record.length),
                        ).joinToString(" · "),
                    )
                }
            }

            item {
                CapabilityNotice()
                Spacer(Modifier.height(20.dp))
            }
        }
    }
}

@Composable
private fun ServerCard(
    state: MainUiState,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onPortChange: (String) -> Unit,
    onExternalOriginChange: (String) -> Unit,
) {
    val runtime = state.server
    val running = runtime.phase == ServerPhase.RUNNING
    val settingsError = state.settings.validationError()
    val statusColor = when (runtime.phase) {
        ServerPhase.RUNNING -> Color(0xFF7CDE72)
        ServerPhase.ERROR -> MaterialTheme.colorScheme.error
        ServerPhase.STARTING, ServerPhase.STOPPING -> Color(0xFFFFC857)
        ServerPhase.STOPPED -> Color(0xFF718096)
    }
    AppCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(10.dp)
                    .background(statusColor, CircleShape),
            )
            Spacer(Modifier.size(10.dp))
            Column(Modifier.weight(1f)) {
                Text("服务器", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Text(
                    text = when (runtime.phase) {
                        ServerPhase.STOPPED -> "已停止"
                        ServerPhase.STARTING -> "正在启动…"
                        ServerPhase.RUNNING -> "正在局域网共享"
                        ServerPhase.STOPPING -> "正在停止…"
                        ServerPhase.ERROR -> "需要处理"
                    },
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
                )
            }
        }

        runtime.error?.let { InlineError(it) }
        state.actionError?.let { InlineError(it) }

        runtime.urls.forEach { url ->
            ValueBlock(
                if (url.startsWith("https://")) "可信 HTTPS 地址" else "局域网 HTTP 地址",
                url,
                copyValue = url,
            )
        }
        runtime.pairingCode?.let { code -> ValueBlock("六位配对码", code, copyValue = code, prominent = true) }

        OutlinedTextField(
            value = state.settings.portText,
            onValueChange = onPortChange,
            modifier = Modifier.fillMaxWidth(),
            enabled = !running && !runtime.busy,
            singleLine = true,
            label = { Text("服务器端口") },
            supportingText = { Text("默认 8081；Cloudflare Tunnel 的上游地址也必须使用这个端口。") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            isError = settingsError != null,
        )
        OutlinedTextField(
            value = state.settings.externalOriginText,
            onValueChange = onExternalOriginChange,
            modifier = Modifier.fillMaxWidth(),
            enabled = !running && !runtime.busy,
            singleLine = true,
            label = { Text("可信 HTTPS 外部来源（可选）") },
            placeholder = { Text("https://xr.example.com") },
            supportingText = { Text("仅在你已将该域名通过反向代理指向本机时填写。") },
            isError = settingsError != null,
        )
        settingsError?.let { InlineError(it) }

        if (running || runtime.phase == ServerPhase.STARTING) {
            Button(
                onClick = onStop,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = Color.Black,
                ),
            ) {
                Text(if (runtime.phase == ServerPhase.STARTING) "取消启动" else "停止服务器")
            }
        } else {
            Button(
                onClick = onStart,
                modifier = Modifier.fillMaxWidth(),
                enabled = state.folder.treeUri != null && !state.folder.scanning && !runtime.busy && settingsError == null,
            ) {
                Text(if (runtime.phase == ServerPhase.STARTING) "正在启动…" else "启动服务器")
            }
        }
    }
}

@Composable
private fun LibraryCard(
    state: MainUiState,
    onChooseFolder: () -> Unit,
    onRefresh: () -> Unit,
    onClearFolder: () -> Unit,
) {
    val folder = state.folder
    val canReplaceFolder = !state.server.running && !state.server.busy && !folder.scanning
    AppCard {
        Text("媒体文件夹", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Text(
            folder.folderName ?: if (folder.treeUri == null) "尚未选择" else "已授权文件夹",
            style = MaterialTheme.typography.bodyLarge,
        )
        Text(
            if (folder.scanning) "正在扫描…" else "已索引 ${folder.mediaCount} 个可 Range 播放的视频",
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.68f),
        )
        folder.error?.let { InlineError(it) }
        if (folder.skippedUnseekable > 0) {
            Text("已跳过 ${folder.skippedUnseekable} 个大小未知或不可 seek 的文件。")
        }
        if (folder.truncated) {
            InlineError("媒体库达到安全扫描上限，只展示部分内容。")
        }
        OutlinedButton(
            onClick = onChooseFolder,
            modifier = Modifier.fillMaxWidth(),
            enabled = canReplaceFolder,
        ) {
            Text(if (folder.treeUri == null) "选择媒体文件夹" else "更换媒体文件夹")
        }
        OutlinedButton(
            onClick = onRefresh,
            modifier = Modifier.fillMaxWidth(),
            enabled = folder.treeUri != null && !folder.scanning,
        ) {
            Text(if (folder.scanning) "正在扫描…" else "刷新索引")
        }
        if (folder.treeUri != null) {
            TextButton(
                onClick = onClearFolder,
                modifier = Modifier.fillMaxWidth(),
                enabled = canReplaceFolder,
            ) {
                Text("移除文件夹授权")
            }
        }
    }
}

@Composable
private fun CapabilityNotice() {
    AppCard(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.72f)) {
        Text("当前 Beta 能力", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text("• 同一局域网内可通过 HTTP 打开网页并进行普通原片播放。")
        Text("• 视频只做字节 Range 直传，不转码、不超分，能否解码取决于头显浏览器。")
        HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f))
        Text(
            "WebXR 沉浸模式需要浏览器认可的可信 HTTPS。局域网 HTTP 仅能普通播放；正确配置反向代理和上方 HTTPS 外部来源后才能进入 WebXR。",
            color = Color(0xFFFFD166),
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun AppCard(
    containerColor: Color = MaterialTheme.colorScheme.surface,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = containerColor),
        shape = RoundedCornerShape(18.dp),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}

@Composable
private fun ValueBlock(label: String, value: String, copyValue: String, prominent: Boolean = false) {
    val context = LocalContext.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background.copy(alpha = 0.55f), RoundedCornerShape(12.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f))
        Text(
            value,
            style = if (prominent) MaterialTheme.typography.headlineMedium else MaterialTheme.typography.bodyLarge,
            fontFamily = FontFamily.Monospace,
            fontWeight = if (prominent) FontWeight.Bold else FontWeight.Medium,
        )
        TextButton(onClick = { copyToClipboard(context, label, copyValue) }) { Text("复制") }
    }
}

@Composable
private fun InlineError(message: String) {
    Text(
        text = message,
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
private fun MediaRow(title: String, detail: String) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(14.dp),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, maxLines = 1, fontWeight = FontWeight.Medium)
            Text(detail, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f), style = MaterialTheme.typography.bodySmall)
        }
    }
}

private fun copyToClipboard(context: Context, label: String, value: String) {
    val clipboard = context.getSystemService(ClipboardManager::class.java)
    clipboard.setPrimaryClip(ClipData.newPlainText(label, value))
}

private fun formatBytes(bytes: Long): String = when {
    bytes >= 1_073_741_824L -> "%.1f GB".format(bytes / 1_073_741_824.0)
    bytes >= 1_048_576L -> "%.1f MB".format(bytes / 1_048_576.0)
    else -> "%.1f KB".format(bytes / 1_024.0)
}

private fun projectionLabel(projection: String): String = when (projection) {
    "equirect180" -> "VR180"
    "equirect360" -> "VR360"
    else -> "平面"
}
