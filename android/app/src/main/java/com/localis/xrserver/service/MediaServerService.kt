package com.localis.xrserver.service

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.localis.xrserver.LocalisApplication
import com.localis.xrserver.MainActivity
import com.localis.xrserver.R
import com.localis.xrserver.network.LanAddressProvider
import com.localis.xrserver.server.HttpServerConfig
import com.localis.xrserver.server.LocalisHttpServer
import java.net.Inet4Address
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * User-controlled foreground service that owns the LAN listener and every
 * resource needed to keep it reachable. No listener or power/Wi-Fi lock is
 * retained after [ACTION_STOP] or service destruction.
 */
class MediaServerService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val lifecycleMutex = Mutex()

    private val container by lazy { (application as LocalisApplication).container }
    private val connectivity by lazy { getSystemService(ConnectivityManager::class.java) }
    private val notificationManager by lazy { getSystemService(NotificationManager::class.java) }

    @Volatile
    private var server: LocalisHttpServer? = null

    @Volatile
    private var boundAddress: Inet4Address? = null

    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var addressCheckJob: Job? = null
    private var addressMonitorJob: Job? = null
    @Volatile
    private var startJob: Job? = null
    private var networkCallbackRegistered = false

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onLost(network: Network) = scheduleAddressCheck()

        override fun onAvailable(network: Network) = scheduleAddressCheck()

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
            scheduleAddressCheck()
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        runCatching {
            connectivity.registerDefaultNetworkCallback(networkCallback)
            networkCallbackRegistered = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action ?: ACTION_START) {
            ACTION_START -> {
                startInForeground(notification("正在启动局域网服务器…"))
                if (startJob?.isActive != true) {
                    val job = serviceScope.launch { startServer() }
                    startJob = job
                    job.invokeOnCompletion {
                        if (startJob === job) startJob = null
                    }
                }
            }
            ACTION_STOP -> {
                val pendingStart = startJob
                pendingStart?.cancel()
                serviceScope.launch {
                    pendingStart?.join()
                    stopServer(stopService = true)
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        startJob?.cancel()
        startJob = null
        addressCheckJob?.cancel()
        addressMonitorJob?.cancel()
        if (networkCallbackRegistered) {
            runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
            networkCallbackRegistered = false
        }
        // Service destruction is the final ownership boundary. Closing here is
        // deliberately synchronous so no listener can outlive the component.
        runCatching { server?.close() }
        server = null
        boundAddress = null
        releaseRuntimeLocks()
        if (container.serverRuntime.state.value.phase != ServerPhase.ERROR) {
            container.serverRuntime.set(ServerRuntimeState())
        }
        serviceScope.cancel()
        super.onDestroy()
    }

    private suspend fun startServer() = lifecycleMutex.withLock {
        if (server?.isRunning == true) {
            refreshRunningNotification()
            return@withLock
        }
        container.serverRuntime.set(ServerRuntimeState(phase = ServerPhase.STARTING))
        val tree = container.mediaRepository.selectedTreeUri()
        if (tree == null) {
            failStart("请先选择媒体文件夹。")
            return@withLock
        }
        val address = withContext(Dispatchers.IO) {
            LanAddressProvider.currentIpv4Addresses(applicationContext).firstOrNull()
        }
        if (address == null) {
            failStart("未找到可供头显访问的 Wi-Fi、热点或以太网 IPv4 地址。")
            return@withLock
        }
        val settings = try {
            container.serverSettings.resolved()
        } catch (error: IllegalArgumentException) {
            failStart(error.message ?: "服务器端口或外部 HTTPS 来源无效。")
            return@withLock
        }
        val localUrl = "http://${address.hostAddress}:${settings.port}"
        val advertisedUrls = listOfNotNull(localUrl, settings.externalOrigin)

        val candidate = LocalisHttpServer(
            config = HttpServerConfig(
                bindAddress = address,
                port = settings.port,
                scheme = "http",
                allowedHosts = setOf(address.hostAddress, "localhost", "127.0.0.1"),
                advertisedUrls = advertisedUrls,
                publicUrl = settings.externalOrigin,
            ),
            backend = container.mediaBackend,
            onFatalError = { failure ->
                serviceScope.launch {
                    stopServer(
                        stopService = true,
                        error = "服务器监听异常，已安全停止：${failure.message ?: "未知网络错误"}",
                    )
                }
            },
        )
        server = candidate
        try {
            val binding = withContext(Dispatchers.IO) { candidate.start() }
            boundAddress = address
            acquireRuntimeLocks()
            val url = "http://${address.hostAddress}:${binding.port}"
            container.serverRuntime.set(
                ServerRuntimeState(
                    phase = ServerPhase.RUNNING,
                    urls = listOfNotNull(url, settings.externalOrigin),
                    pairingCode = candidate.pairingCode,
                ),
            )
            startAddressMonitor(address)
            notificationManager.notify(NOTIFICATION_ID, notification("服务器地址：$url"))
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable + Dispatchers.IO) { runCatching { candidate.close() } }
            server = null
            boundAddress = null
            releaseRuntimeLocks()
            throw cancelled
        } catch (error: Throwable) {
            withContext(Dispatchers.IO) { runCatching { candidate.close() } }
            server = null
            boundAddress = null
            releaseRuntimeLocks()
            failStart(error.message ?: "服务器启动失败。")
        }
    }

    private suspend fun stopServer(stopService: Boolean, error: String? = null) = lifecycleMutex.withLock {
        container.serverRuntime.set(ServerRuntimeState(phase = ServerPhase.STOPPING))
        val current = server
        server = null
        boundAddress = null
        addressCheckJob?.cancel()
        addressCheckJob = null
        addressMonitorJob?.cancel()
        addressMonitorJob = null
        withContext(Dispatchers.IO) { runCatching { current?.close() } }
        releaseRuntimeLocks()
        container.serverRuntime.set(
            if (error == null) ServerRuntimeState()
            else ServerRuntimeState(phase = ServerPhase.ERROR, error = error),
        )
        if (stopService) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun failStart(message: String) {
        container.serverRuntime.set(ServerRuntimeState(phase = ServerPhase.ERROR, error = message))
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun scheduleAddressCheck() {
        val address = boundAddress ?: return
        addressCheckJob?.cancel()
        addressCheckJob = serviceScope.launch {
            delay(1_000)
            if (!LanAddressProvider.isStillAvailable(applicationContext, address)) {
                serviceScope.launch {
                    stopServer(
                        stopService = true,
                        error = "局域网地址已变化，服务器已安全停止；请连接网络后重新启动。",
                    )
                }
            }
        }
    }

    private fun startAddressMonitor(address: Inet4Address) {
        addressMonitorJob?.cancel()
        addressMonitorJob = serviceScope.launch monitor@{
            while (boundAddress?.hostAddress == address.hostAddress && server?.isRunning == true) {
                delay(10_000)
                if (!LanAddressProvider.isStillAvailable(applicationContext, address)) {
                    serviceScope.launch {
                        stopServer(
                            stopService = true,
                            error = "局域网地址已变化，服务器已安全停止；请连接网络后重新启动。",
                        )
                    }
                    return@monitor
                }
            }
        }
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireRuntimeLocks() {
        if (wakeLock?.isHeld != true) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:media-server")
                .apply {
                    setReferenceCounted(false)
                    acquire()
                }
        }
        if (wifiLock?.isHeld != true) {
            @Suppress("DEPRECATION")
            val lock = applicationContext.getSystemService(WifiManager::class.java)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "$packageName:media-server")
            wifiLock = lock.apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun releaseRuntimeLocks() {
        wifiLock?.let { lock -> if (lock.isHeld) runCatching { lock.release() } }
        wifiLock = null
        wakeLock?.let { lock -> if (lock.isHeld) runCatching { lock.release() } }
        wakeLock = null
    }

    private fun refreshRunningNotification() {
        val url = container.serverRuntime.state.value.urls.firstOrNull()
        notificationManager.notify(
            NOTIFICATION_ID,
            notification(url?.let { "服务器地址：$it" } ?: "局域网服务器运行中"),
        )
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL,
            getString(R.string.server_notification_channel),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.server_notification_channel_description)
            setShowBadge(false)
        }
        notificationManager.createNotificationChannel(channel)
    }

    private fun startInForeground(notification: Notification) {
        val serviceType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, serviceType)
    }

    private fun notification(detail: String): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, MediaServerService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL)
            .setSmallIcon(R.drawable.ic_server_notification)
            .setContentTitle(getString(R.string.server_notification_title))
            .setContentText(detail)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, getString(R.string.server_notification_stop), stopIntent)
            .build()
    }

    companion object {
        private const val ACTION_START = "com.localis.xrserver.action.START"
        private const val ACTION_STOP = "com.localis.xrserver.action.STOP"
        private const val NOTIFICATION_CHANNEL = "localis-media-server"
        private const val NOTIFICATION_ID = 101

        fun start(context: Context) {
            val intent = Intent(context, MediaServerService::class.java).setAction(ACTION_START)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, MediaServerService::class.java).setAction(ACTION_STOP)
            context.startService(intent)
        }
    }
}
