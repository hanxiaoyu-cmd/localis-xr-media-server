package com.localis.xrplayer.ui

import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.localis.xrplayer.data.PlaybackProgress
import com.localis.xrplayer.data.PlaybackSources
import com.localis.xrplayer.data.PublicMediaItem
import com.localis.xrplayer.data.LocalisApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

private enum class PlaybackMode { DIRECT, COMPATIBILITY }

@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(
    item: PublicMediaItem,
    savedProgress: PlaybackProgress?,
    sources: PlaybackSources,
    mediaDataSourceFactory: DataSource.Factory,
    awaitCompatibility: suspend () -> HttpUrl,
    saveProgress: (positionMs: Long, durationMs: Long) -> Unit,
    onPairingRequired: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val player = remember(item.id) {
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(mediaDataSourceFactory))
            .build()
    }
    val playbackEngine = player
    val initialPosition = remember(item.id) {
        val requested = ((savedProgress?.position ?: 0.0) * 1_000).toLong().coerceAtLeast(0)
        val maximum = ((item.duration * 1_000).toLong() - 1_000).coerceAtLeast(0)
        if (maximum > 0) requested.coerceAtMost(maximum) else requested
    }
    var mode by remember(item.id) { mutableStateOf(PlaybackMode.DIRECT) }
    var compatibilityUrl by remember(item.id) { mutableStateOf<HttpUrl?>(null) }
    var sourceGeneration by remember(item.id) { mutableIntStateOf(0) }
    var desiredPosition by remember(item.id) { mutableLongStateOf(initialPosition) }
    var preparingCompatibility by remember(item.id) { mutableStateOf(false) }
    var playbackError by remember(item.id) { mutableStateOf<String?>(null) }
    var compatibilityJob by remember(item.id) { mutableStateOf<Job?>(null) }
    var lifecycleStarted by remember(lifecycleOwner) {
        mutableStateOf(lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
    }
    val lifecyclePause = remember(item.id) { mutableStateOf(false) }
    var shouldAutoPlay by remember(item.id) { mutableStateOf(true) }

    fun durationMs(): Long = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }
        ?: (item.duration * 1_000).toLong().coerceAtLeast(0)

    fun saveNow() {
        saveProgress(player.currentPosition.coerceAtLeast(0), durationMs())
    }

    val requestCompatibility: () -> Unit = {
        if (
            !preparingCompatibility &&
            !lifecyclePause.value &&
            lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        ) {
            desiredPosition = player.currentPosition.coerceAtLeast(0)
            preparingCompatibility = true
            playbackError = null
            compatibilityJob?.cancel()
            compatibilityJob = scope.launch {
                try {
                    compatibilityUrl = awaitCompatibility()
                    mode = PlaybackMode.COMPATIBILITY
                    sourceGeneration += 1
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Throwable) {
                    if (error is LocalisApiException && error.status == 401) onPairingRequired()
                    else playbackError = error.message ?: "兼容流准备失败"
                } finally {
                    preparingCompatibility = false
                }
            }
        }
    }

    LaunchedEffect(mode, compatibilityUrl, sourceGeneration, lifecycleStarted) {
        if (!lifecycleStarted) {
            player.pause()
            return@LaunchedEffect
        }
        val source = when (mode) {
            PlaybackMode.DIRECT -> sources.direct
            PlaybackMode.COMPATIBILITY -> compatibilityUrl ?: return@LaunchedEffect
        }
        playbackError = null
        player.setMediaItem(MediaItem.fromUri(source.toString()), desiredPosition)
        player.prepare()
        player.playWhenReady = shouldAutoPlay
    }

    DisposableEffect(player, mode) {
        val listener = object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                desiredPosition = player.currentPosition.coerceAtLeast(0)
                if (mode == PlaybackMode.DIRECT) {
                    requestCompatibility()
                } else {
                    playbackError = "播放失败：${error.errorCodeName}"
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_READY) playbackError = null
                if (playbackState == Player.STATE_ENDED) saveNow()
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (
                    !lifecyclePause.value &&
                    lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
                ) {
                    shouldAutoPlay = playWhenReady
                }
            }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener) }
    }

    DisposableEffect(lifecycleOwner, player) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> {
                    lifecyclePause.value = false
                    lifecycleStarted = true
                }
                Lifecycle.Event.ON_STOP -> {
                    lifecyclePause.value = true
                    lifecycleStarted = false
                    shouldAutoPlay = player.playWhenReady
                    desiredPosition = player.currentPosition.coerceAtLeast(0)
                    compatibilityJob?.cancel()
                    preparingCompatibility = false
                    saveNow()
                    player.pause()
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            compatibilityJob?.cancel()
            saveNow()
            player.release()
        }
    }

    LaunchedEffect(player, lifecycleStarted) {
        if (!lifecycleStarted) return@LaunchedEffect
        while (isActive) {
            delay(8_000)
            if (player.currentPosition > 0) saveNow()
        }
    }

    BackHandler {
        saveNow()
        onBack()
    }

    Column(modifier = Modifier.fillMaxSize().background(Color.Black).statusBarsPadding()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedButton(onClick = {
                saveNow()
                onBack()
            }) { Text("返回媒体库") }
            Spacer(Modifier.width(16.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(item.title, maxLines = 1, color = Color.White)
                Text(
                    if (mode == PlaybackMode.DIRECT) {
                        "原始文件直连"
                    } else if (item.kind == "audio") {
                        "AAC 兼容流"
                    } else {
                        "H.264/AAC 兼容流"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = Color.LightGray,
                )
            }
            Button(onClick = requestCompatibility, enabled = !preparingCompatibility) {
                Text(if (mode == PlaybackMode.DIRECT) "切换兼容播放" else "重新准备兼容流")
            }
        }

        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { viewContext ->
                    PlayerView(viewContext).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        useController = true
                        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                        keepScreenOn = true
                        setPlayer(playbackEngine)
                    }
                },
                update = { it.setPlayer(player) },
            )
            if (preparingCompatibility) {
                Column(
                    modifier = Modifier.background(Color(0xCC111827), MaterialTheme.shapes.medium).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    CircularProgressIndicator()
                    Text(
                        if (item.kind == "audio") "电脑端正在准备 AAC 兼容流…" else "电脑端正在准备兼容流…",
                        color = Color.White,
                    )
                }
            }
            playbackError?.let { message ->
                Column(
                    modifier = Modifier.background(Color(0xE61F2937), MaterialTheme.shapes.medium).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(message, color = MaterialTheme.colorScheme.error)
                    Button(onClick = requestCompatibility) { Text("重试兼容播放") }
                }
            }
        }
    }
}
