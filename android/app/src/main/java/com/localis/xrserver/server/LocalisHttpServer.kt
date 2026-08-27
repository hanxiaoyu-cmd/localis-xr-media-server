package com.localis.xrserver.server

import com.localis.xrserver.data.ApiError
import com.localis.xrserver.data.DirectPlaybackStatus
import com.localis.xrserver.data.HealthResponse
import com.localis.xrserver.data.LibraryRefreshResponse
import com.localis.xrserver.data.LibraryResponse
import com.localis.xrserver.data.MediaDetailResponse
import com.localis.xrserver.data.MediaPatch
import com.localis.xrserver.data.MediaUpdateResponse
import com.localis.xrserver.data.PairStatusResponse
import com.localis.xrserver.data.PairVerifyRequest
import com.localis.xrserver.data.PairVerifyResponse
import com.localis.xrserver.data.PlaybackProgress
import com.localis.xrserver.data.ProgressRequest
import com.localis.xrserver.data.ProgressResponse
import com.localis.xrserver.data.ServerInfoResponse
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.Semaphore
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

enum class ServerState { STOPPED, STARTING, RUNNING, STOPPING }

data class ServerBinding(
    val bindAddress: String,
    val port: Int,
    val scheme: String,
)

data class HttpServerConfig(
    val bindAddress: InetAddress = InetAddress.getByName("0.0.0.0"),
    val port: Int = 0,
    /** External request scheme used by the exact Origin check. */
    val scheme: String = "http",
    val allowedHosts: Set<String> = setOf("localhost", "127.0.0.1", "::1"),
    val advertisedUrls: List<String> = emptyList(),
    val publicUrl: String? = null,
    val maxConcurrentConnections: Int = 8,
    val maxConcurrentMediaStreams: Int = 6,
    val socketReadTimeoutMillis: Int = 15_000,
    val requestReadDeadlineMillis: Int = 20_000,
    val responseWriteIdleTimeoutMillis: Int = 30_000,
    val backlog: Int = 32,
    val limits: HttpLimits = HttpLimits(),
) {
    init {
        require(port in 0..65_535)
        require(scheme == "http" || scheme == "https")
        require(allowedHosts.isNotEmpty())
        publicUrl?.let { configured ->
            require(RequestSecurity.parseOrigin(configured)?.scheme == "https") {
                "Public URL must be an exact HTTPS origin without credentials, path, query, or fragment"
            }
        }
        require(maxConcurrentConnections in 1..128)
        require(maxConcurrentMediaStreams in 1..maxConcurrentConnections)
        require(socketReadTimeoutMillis in 1_000..120_000)
        require(requestReadDeadlineMillis in 1_000..120_000)
        require(responseWriteIdleTimeoutMillis in 5_000..300_000)
        require(backlog in 1..1_024)
    }
}

/**
 * Small HTTP/1.1 server for the Android-hosted Localis beta.
 *
 * Every connection processes exactly one request and then closes. The class is
 * Android-framework free so the protocol and security boundary can be tested
 * on the JVM.
 */
class LocalisHttpServer(
    private val config: HttpServerConfig,
    private val backend: MediaServerBackend,
    private val auth: PairingSessionManager = PairingSessionManager(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val onFatalError: (Throwable) -> Unit = {},
) : AutoCloseable {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }
    private val parser = HttpRequestParser(config.limits)
    private val lifecycleLock = Any()
    private val activeSockets = ConcurrentHashMap.newKeySet<Socket>()
    private val refreshInProgress = AtomicBoolean(false)
    private val mediaPermits = Semaphore(config.maxConcurrentMediaStreams)

    @Volatile
    var state: ServerState = ServerState.STOPPED
        private set

    @Volatile
    var binding: ServerBinding? = null
        private set

    val pairingCode: String get() = auth.pairingCode
    val isRunning: Boolean get() = state == ServerState.RUNNING

    private var listener: ServerSocket? = null
    private var acceptExecutor: ExecutorService? = null
    private var requestExecutor: ExecutorService? = null
    private var writeWatchdogExecutor: ScheduledExecutorService? = null
    private var permits: Semaphore? = null

    fun start(): ServerBinding = synchronized(lifecycleLock) {
        binding?.takeIf { state == ServerState.RUNNING }?.let { return@synchronized it }
        check(state == ServerState.STOPPED) { "Server is transitioning" }
        state = ServerState.STARTING
        auth.startNewEpoch()
        try {
            val socket = ServerSocket()
            socket.reuseAddress = true
            socket.bind(InetSocketAddress(config.bindAddress, config.port), config.backlog)
            val actualBinding = ServerBinding(
                bindAddress = socket.inetAddress.hostAddress ?: config.bindAddress.hostAddress,
                port = socket.localPort,
                scheme = config.scheme,
            )
            val workers = Executors.newFixedThreadPool(
                config.maxConcurrentConnections,
                namedDaemonFactory("localis-http"),
            )
            val accepter = Executors.newSingleThreadExecutor(namedDaemonFactory("localis-accept"))
            val writeWatchdogs = Executors.newSingleThreadScheduledExecutor(
                namedDaemonFactory("localis-write-watchdog"),
            )
            listener = socket
            requestExecutor = workers
            acceptExecutor = accepter
            writeWatchdogExecutor = writeWatchdogs
            permits = Semaphore(config.maxConcurrentConnections)
            binding = actualBinding
            state = ServerState.RUNNING
            accepter.execute { acceptLoop(socket, workers) }
            actualBinding
        } catch (error: Throwable) {
            listener?.runCatching { close() }
            acceptExecutor?.shutdownNow()
            requestExecutor?.shutdownNow()
            writeWatchdogExecutor?.shutdownNow()
            listener = null
            acceptExecutor = null
            requestExecutor = null
            writeWatchdogExecutor = null
            binding = null
            auth.invalidateAll()
            state = ServerState.STOPPED
            throw error
        }
    }

    fun stop() = synchronized(lifecycleLock) {
        if (state == ServerState.STOPPED) {
            auth.invalidateAll()
            return@synchronized
        }
        state = ServerState.STOPPING
        listener?.runCatching { close() }
        listener = null
        activeSockets.forEach { socket -> socket.runCatching { close() } }
        activeSockets.clear()
        acceptExecutor?.shutdownNow()
        requestExecutor?.shutdownNow()
        writeWatchdogExecutor?.shutdownNow()
        acceptExecutor?.awaitTermination(2, TimeUnit.SECONDS)
        requestExecutor?.awaitTermination(2, TimeUnit.SECONDS)
        writeWatchdogExecutor?.awaitTermination(2, TimeUnit.SECONDS)
        acceptExecutor = null
        requestExecutor = null
        writeWatchdogExecutor = null
        permits = null
        binding = null
        auth.invalidateAll()
        state = ServerState.STOPPED
    }

    override fun close() = stop()

    private fun acceptLoop(serverSocket: ServerSocket, workers: ExecutorService) {
        while (state == ServerState.RUNNING && !serverSocket.isClosed) {
            val client = try {
                serverSocket.accept()
            } catch (error: SocketException) {
                if (state == ServerState.RUNNING) failClosedListener(error)
                return
            } catch (error: IOException) {
                if (state == ServerState.RUNNING) failClosedListener(error)
                return
            }
            client.soTimeout = config.socketReadTimeoutMillis
            client.tcpNoDelay = true
            val gate = permits
            if (gate == null || !gate.tryAcquire()) {
                rejectBusy(client)
                continue
            }
            activeSockets += client
            try {
                workers.execute {
                    try {
                        client.use(::handleClient)
                    } finally {
                        activeSockets -= client
                        gate.release()
                    }
                }
            } catch (_: RuntimeException) {
                activeSockets -= client
                gate.release()
                client.runCatching { close() }
            }
        }
    }

    private fun failClosedListener(error: Throwable) {
        val shouldReport = synchronized(lifecycleLock) {
            if (state != ServerState.RUNNING) return@synchronized false
            state = ServerState.STOPPING
            listener?.runCatching { close() }
            listener = null
            activeSockets.forEach { it.runCatching { close() } }
            activeSockets.clear()
            requestExecutor?.shutdownNow()
            acceptExecutor?.shutdown()
            writeWatchdogExecutor?.shutdownNow()
            requestExecutor = null
            acceptExecutor = null
            writeWatchdogExecutor = null
            permits = null
            binding = null
            auth.invalidateAll()
            state = ServerState.STOPPED
            true
        }
        if (shouldReport) runCatching { onFatalError(error) }
    }

    private fun rejectBusy(socket: Socket) {
        socket.use {
            runCatching {
                HttpResponseWriter(it.getOutputStream(), headOnly = false).sendBytes(
                    status = 503,
                    contentType = JSON_CONTENT_TYPE,
                    body = "{\"error\":\"server_busy\",\"message\":\"服务器连接已满。\"}".toByteArray(),
                    headers = mapOf("Retry-After" to "1", "Cache-Control" to "no-store"),
                )
            }
        }
    }

    private fun handleClient(socket: Socket) {
        val watchdog = ResponseWriteWatchdog(
            scheduler = writeWatchdogExecutor,
            timeoutMillis = config.responseWriteIdleTimeoutMillis,
            onTimeout = { socket.runCatching { close() } },
        )
        var writer = HttpResponseWriter(
            socket.getOutputStream(),
            headOnly = false,
            onWriteStart = watchdog::start,
            onWriteProgress = watchdog::progress,
        )
        try {
            val request = parser.parse(
                DeadlineInputStream(
                    source = socket.getInputStream(),
                    timeoutMillis = config.requestReadDeadlineMillis,
                    beforeBlockingRead = { remainingMillis ->
                        socket.soTimeout = minOf(config.socketReadTimeoutMillis, remainingMillis)
                    },
                ),
            ) ?: return
            writer = HttpResponseWriter(
                socket.getOutputStream(),
                headOnly = request.method == "HEAD",
                onWriteStart = watchdog::start,
                onWriteProgress = watchdog::progress,
            )
            handleRequest(request, socket, writer)
        } catch (_: SocketTimeoutException) {
            if (!writer.committed) sendError(writer, HttpProblem(408, "request_timeout", "请求读取超时。"))
        } catch (problem: HttpProblem) {
            if (!writer.committed) sendError(writer, problem)
        } catch (_: Throwable) {
            if (!writer.committed) {
                sendError(writer, HttpProblem(500, "internal_error", "请求处理失败。"))
            }
        } finally {
            watchdog.close()
        }
    }

    private fun handleRequest(request: ParsedHttpRequest, socket: Socket, writer: HttpResponseWriter) {
        val hostHeader = request.header("host")
            ?: throw HttpProblem(400, "host_required", "缺少 Host 请求头。")
        val requestScheme = trustedSchemeForHost(hostHeader)
        if (requestScheme == null) {
            throw HttpProblem(421, "unrecognized_host", "Host 不在允许列表中。")
        }
        if (request.method !in SAFE_METHODS) {
            val origin = request.header("origin")
                ?: throw HttpProblem(403, "origin_required", "写请求必须包含 Origin。")
            if (!RequestSecurity.originMatches(requestScheme, hostHeader, origin)) {
                throw HttpProblem(403, "origin_mismatch", "Origin 与当前服务地址不匹配。")
            }
        }

        val path = RoutingPaths.parse(request.target)
        val isApi = path.segments.firstOrNull() == "api"
        val isPublicApi = path.segments == listOf("api", "health") ||
            path.segments == listOf("api", "pair", "status") ||
            path.segments == listOf("api", "pair", "verify")
        if (isApi && !isPublicApi && !auth.authenticate(request.header("cookie"))) {
            throw HttpProblem(401, "pairing_required", "请先完成设备配对。")
        }

        when {
            path.segments == listOf("api", "health") -> {
                requireMethod(request, "GET", "HEAD")
                sendJson(
                    writer,
                    200,
                    HealthResponse(
                        build = backend.build,
                        mediaCount = backend.listMedia().size,
                    ),
                )
            }
            path.segments == listOf("api", "pair", "status") -> {
                requireMethod(request, "GET", "HEAD")
                val paired = auth.authenticate(request.header("cookie"))
                sendJson(
                    writer,
                    200,
                    PairStatusResponse(
                        paired = paired,
                        pairingCode = auth.pairingCode.takeIf { socket.inetAddress.isLoopbackAddress },
                    ),
                )
            }
            path.segments == listOf("api", "pair", "verify") -> {
                requireMethod(request, "POST")
                val body = decodeJson<PairVerifyRequest>(request)
                when (val result = auth.verify(body.code.trim(), remoteKey(socket))) {
                    is PairingResult.Success -> sendJson(
                        writer,
                        200,
                        PairVerifyResponse(),
                        headers = mapOf("Set-Cookie" to sessionCookie(result, secure = requestScheme == "https")),
                    )
                    is PairingResult.Invalid -> sendJson(
                        writer,
                        401,
                        ApiError("invalid_pairing_code", attemptsRemaining = result.attemptsRemaining),
                    )
                    is PairingResult.RateLimited -> sendJson(
                        writer,
                        429,
                        ApiError("too_many_attempts", retryAfter = result.retryAfterSeconds),
                        headers = mapOf("Retry-After" to result.retryAfterSeconds.toString()),
                    )
                }
            }
            path.segments == listOf("api", "server") -> {
                requireMethod(request, "GET", "HEAD")
                val authority = RequestSecurity.parseAuthority(hostHeader)
                    ?: throw HttpProblem(400, "invalid_host", "Host 请求头无效。")
                binding ?: throw HttpProblem(503, "server_stopping", "服务器正在停止。")
                val responsePort = authority.port ?: RequestSecurity.defaultPort(requestScheme)
                val advertised = config.advertisedUrls.ifEmpty {
                    val withPort = authority.copy(
                        port = authority.port ?: RequestSecurity.defaultPort(requestScheme),
                    )
                    listOf("$requestScheme://${withPort.render()}")
                }
                sendJson(
                    writer,
                    200,
                    ServerInfoResponse(
                        name = backend.serverName,
                        build = backend.build,
                        secure = requestScheme == "https",
                        host = authority.host,
                        port = responsePort,
                        mediaCount = backend.listMedia().size,
                        libraryCount = backend.mediaRootCount,
                        pairingCode = auth.pairingCode.takeIf { socket.inetAddress.isLoopbackAddress },
                        lanUrls = advertised,
                        publicUrl = config.publicUrl,
                    ),
                )
            }
            path.segments == listOf("api", "library") -> {
                requireMethod(request, "GET", "HEAD")
                sendJson(writer, 200, LibraryResponse(backend.listMedia(), backend.listProgress()))
            }
            path.segments == listOf("api", "library", "refresh") -> {
                requireMethod(request, "POST")
                requireJsonContentType(request)
                if (!refreshInProgress.compareAndSet(false, true)) {
                    sendJson(writer, 200, LibraryRefreshResponse(backend.listMedia()))
                } else {
                    try {
                        sendJson(writer, 200, LibraryRefreshResponse(backend.refreshMedia()))
                    } finally {
                        refreshInProgress.set(false)
                    }
                }
            }
            path.segments.size == 3 && path.segments.take(2) == listOf("api", "media") -> {
                val id = path.segments[2]
                when (request.method) {
                    "GET", "HEAD" -> {
                        val item = backend.findMedia(id)
                            ?: throw HttpProblem(404, "media_not_found", "媒体不存在。")
                        sendJson(
                            writer,
                            200,
                            MediaDetailResponse(
                                item = item,
                                progress = backend.findProgress(id),
                                transcode = DirectPlaybackStatus(durationSeconds = item.duration),
                                build = backend.build,
                            ),
                        )
                    }
                    "PATCH" -> {
                        val requested = decodeJson<MediaPatch>(request)
                        val item = backend.updateMedia(id, sanitizePatch(requested))
                            ?: throw HttpProblem(404, "media_not_found", "媒体不存在。")
                        sendJson(writer, 200, MediaUpdateResponse(item))
                    }
                    else -> methodNotAllowed("GET", "HEAD", "PATCH")
                }
            }
            path.segments.size == 4 &&
                path.segments.take(2) == listOf("api", "media") &&
                path.segments[3] == "stream" -> {
                requireMethod(request, "GET", "HEAD")
                if (!mediaPermits.tryAcquire()) {
                    throw HttpProblem(
                        503,
                        "media_streams_busy",
                        "媒体连接已满，请稍后重试。",
                        mapOf("Retry-After" to "1"),
                    )
                }
                try {
                    streamMedia(path.segments[2], request, writer)
                } finally {
                    mediaPermits.release()
                }
            }
            path.segments.size == 3 && path.segments.take(2) == listOf("api", "progress") -> {
                requireMethod(request, "PUT")
                val id = path.segments[2]
                if (backend.findMedia(id) == null) throw HttpProblem(404, "media_not_found", "媒体不存在。")
                val requested = decodeJson<ProgressRequest>(request)
                val progress = PlaybackProgress(
                    mediaId = id,
                    position = requested.position.takeIf(Double::isFinite)?.coerceAtLeast(0.0) ?: 0.0,
                    duration = requested.duration.takeIf(Double::isFinite)?.coerceAtLeast(0.0) ?: 0.0,
                    updatedAt = Instant.ofEpochMilli(clock()).toString(),
                )
                sendJson(writer, 200, ProgressResponse(backend.saveProgress(progress)))
            }
            isApi -> throw HttpProblem(404, "api_not_found", "API 不存在。")
            else -> serveStatic(path, request, writer)
        }
    }

    private fun streamMedia(id: String, request: ParsedHttpRequest, writer: HttpResponseWriter) {
        val content = backend.openMedia(id)
            ?: throw HttpProblem(404, "media_not_found", "媒体不存在。")
        require(content.item.id == id) { "Backend returned the wrong media item" }
        val etag = normalizeEtag(content.etag)
        val lastModified = HTTP_DATE.format(
            Instant.ofEpochMilli(content.lastModifiedEpochMillis).atZone(ZoneOffset.UTC),
        )
        val ifRange = request.header("if-range")
        val requestedRange = if (
            ifRange != null && !ifRangeMatches(ifRange, etag, content.lastModifiedEpochMillis)
        ) {
            null
        } else {
            request.header("range")
        }
        val range = try {
            ByteRanges.parse(requestedRange, content.length)
        } catch (_: RangeNotSatisfiableException) {
            writer.sendBytes(
                status = 416,
                contentType = "application/octet-stream",
                body = ByteArray(0),
                headers = mapOf(
                    "Accept-Ranges" to "bytes",
                    "Content-Range" to "bytes */${content.length}",
                    "Cache-Control" to PRIVATE_REVALIDATE,
                ),
            )
            return
        }
        val commonHeaders = mapOf(
            "Accept-Ranges" to "bytes",
            "Cache-Control" to PRIVATE_REVALIDATE,
            "ETag" to etag,
            "Last-Modified" to lastModified,
            "Content-Disposition" to "inline; filename*=UTF-8''${encodeHeaderFileName(content.fileName)}",
        )
        if (range == null) {
            writer.sendStream(
                status = 200,
                contentType = content.contentType,
                contentLength = content.length,
                headers = commonHeaders,
                open = { content.openAt(0) },
            )
        } else {
            writer.sendStream(
                status = 206,
                contentType = content.contentType,
                contentLength = range.length,
                headers = commonHeaders + mapOf(
                    "Content-Range" to "bytes ${range.start}-${range.endInclusive}/${content.length}",
                ),
                open = { content.openAt(range.start) },
            )
        }
    }

    private fun serveStatic(path: RoutingPath, request: ParsedHttpRequest, writer: HttpResponseWriter) {
        requireMethod(request, "GET", "HEAD")
        val requested = path.relativeAssetPath.ifEmpty { "index.html" }
        val asset = backend.staticAssets.open(requested)
            ?: (if (path.segments.firstOrNull() == "watch") backend.staticAssets.open("index.html") else null)
            ?: throw HttpProblem(404, "not_found", "页面不存在。")
        val headers = linkedMapOf(
            "Cache-Control" to if (requested == "index.html" || path.segments.firstOrNull() == "watch") {
                "no-cache"
            } else {
                asset.cacheControl
            },
            "ETag" to normalizeEtag(asset.etag),
            "Content-Security-Policy" to STATIC_CSP,
        )
        asset.lastModifiedEpochMillis?.let { timestamp ->
            headers["Last-Modified"] = HTTP_DATE.format(Instant.ofEpochMilli(timestamp).atZone(ZoneOffset.UTC))
        }
        writer.sendStream(
            status = 200,
            contentType = asset.contentType,
            contentLength = asset.length,
            headers = headers,
            open = asset.open,
        )
    }

    private fun sanitizePatch(requested: MediaPatch): MediaPatch = MediaPatch(
        projection = requested.projection?.takeIf { it in PROJECTIONS },
        stereo = requested.stereo?.takeIf { it in STEREO_LAYOUTS },
        eyeOrder = requested.eyeOrder?.takeIf { it in EYE_ORDERS },
        yawOffset = requested.yawOffset?.takeIf(Double::isFinite)?.coerceIn(-Math.PI * 2, Math.PI * 2),
        title = requested.title?.trim()?.takeIf { it.length <= 200 },
    )

    private fun trustedSchemeForHost(hostHeader: String): String? {
        val listenerPort = binding?.port ?: return null
        if (
            RequestSecurity.isAllowedLocalAuthority(
                hostHeader = hostHeader,
                allowedHosts = config.allowedHosts,
                scheme = config.scheme,
                listenerPort = listenerPort,
            )
        ) {
            return config.scheme
        }
        val publicUrl = config.publicUrl ?: return null
        if (!RequestSecurity.authorityMatchesConfiguredOrigin(hostHeader, publicUrl)) return null
        return RequestSecurity.parseOrigin(publicUrl)?.scheme
    }

    private inline fun <reified T> decodeJson(request: ParsedHttpRequest): T {
        requireJsonContentType(request)
        if (request.body.isEmpty()) throw HttpProblem(400, "invalid_json", "JSON 请求体不能为空。")
        return try {
            json.decodeFromString(request.body.toString(StandardCharsets.UTF_8))
        } catch (_: SerializationException) {
            throw HttpProblem(400, "invalid_json", "JSON 请求体无效。")
        } catch (_: IllegalArgumentException) {
            throw HttpProblem(400, "invalid_json", "JSON 请求体无效。")
        }
    }

    private fun requireJsonContentType(request: ParsedHttpRequest) {
        val contentType = request.header("content-type")?.lowercase().orEmpty()
        if (!contentType.substringBefore(';').trim().equals("application/json")) {
            throw HttpProblem(415, "json_content_type_required", "请求必须使用 application/json。")
        }
    }

    private fun requireMethod(request: ParsedHttpRequest, vararg allowed: String) {
        if (request.method !in allowed) methodNotAllowed(*allowed)
    }

    private fun methodNotAllowed(vararg allowed: String): Nothing = throw HttpProblem(
        405,
        "method_not_allowed",
        "请求方法不受支持。",
        mapOf("Allow" to allowed.joinToString(", ")),
    )

    private inline fun <reified T> sendJson(
        writer: HttpResponseWriter,
        status: Int,
        value: T,
        headers: Map<String, String> = emptyMap(),
    ) {
        val body = json.encodeToString(value).toByteArray(StandardCharsets.UTF_8)
        writer.sendBytes(
            status = status,
            contentType = JSON_CONTENT_TYPE,
            body = body,
            headers = mapOf("Cache-Control" to "no-store") + headers,
        )
    }

    private fun sendError(writer: HttpResponseWriter, problem: HttpProblem) {
        runCatching {
            sendJson(
                writer,
                problem.status,
                ApiError(
                    error = problem.code,
                    message = problem.message,
                    retryAfter = problem.responseHeaders["Retry-After"]?.toIntOrNull(),
                ),
                headers = problem.responseHeaders,
            )
        }
    }

    private fun sessionCookie(result: PairingResult.Success, secure: Boolean): String = buildString {
        append(PairingSessionManager.COOKIE_NAME)
        append('=')
        append(result.token)
        append("; Max-Age=")
        append(result.maxAgeSeconds)
        append("; Path=/; HttpOnly; SameSite=Strict")
        if (secure) append("; Secure")
    }

    private fun remoteKey(socket: Socket): String = socket.inetAddress.hostAddress ?: "unknown"

    private fun normalizeEtag(value: String): String {
        require(value.isNotBlank() && value.none { it <= ' ' || it == '\u007f' || it == '\\' }) { "Invalid ETag" }
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("W/\"") && value.endsWith('"'))
        ) return value
        require('"' !in value) { "Invalid ETag" }
        return "\"$value\""
    }

    private fun ifRangeMatches(value: String, etag: String, lastModifiedEpochMillis: Long): Boolean {
        if (value.startsWith("W/") || etag.startsWith("W/")) return false
        if (value.startsWith('"')) return value == etag
        val validatorTime = runCatching { Instant.from(HTTP_DATE.parse(value)).toEpochMilli() }.getOrNull()
            ?: return false
        val resourceSeconds = lastModifiedEpochMillis / 1_000
        val validatorSeconds = validatorTime / 1_000
        return resourceSeconds <= validatorSeconds
    }

    private fun encodeHeaderFileName(value: String): String = buildString {
        value.toByteArray(StandardCharsets.UTF_8).forEach { byte ->
            val unsigned = byte.toInt() and 0xff
            if ((unsigned in 'a'.code..'z'.code) ||
                (unsigned in 'A'.code..'Z'.code) ||
                (unsigned in '0'.code..'9'.code) ||
                unsigned in "!#$&+-.^_`|~".map(Char::code)
            ) {
                append(unsigned.toChar())
            } else {
                append('%')
                append(HEX[unsigned ushr 4])
                append(HEX[unsigned and 0x0f])
            }
        }
    }

    companion object {
        private const val JSON_CONTENT_TYPE = "application/json; charset=utf-8"
        private const val PRIVATE_REVALIDATE = "private, max-age=0, must-revalidate"
        private const val STATIC_CSP = "default-src 'self'; script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
            "connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        private val SAFE_METHODS = setOf("GET", "HEAD", "OPTIONS")
        private val PROJECTIONS = setOf("flat", "equirect180", "equirect360")
        private val STEREO_LAYOUTS = setOf("mono", "sbs", "tb")
        private val EYE_ORDERS = setOf("lr", "rl")
        private val HTTP_DATE = DateTimeFormatter.RFC_1123_DATE_TIME
        private const val HEX = "0123456789ABCDEF"
        private val threadCounter = AtomicInteger()

        private fun namedDaemonFactory(prefix: String) = ThreadFactory { task ->
            Thread(task, "$prefix-${threadCounter.incrementAndGet()}").apply { isDaemon = true }
        }
    }
}

private class ResponseWriteWatchdog(
    scheduler: ScheduledExecutorService?,
    timeoutMillis: Int,
    private val onTimeout: () -> Unit,
    private val nanoTime: () -> Long = System::nanoTime,
) : AutoCloseable {
    private val timeoutNanos = timeoutMillis * 1_000_000L
    private val task: ScheduledFuture<*>?

    @Volatile
    private var active = false

    @Volatile
    private var closed = false

    @Volatile
    private var lastProgressNanos = nanoTime()

    init {
        val periodMillis = minOf(5_000L, maxOf(1_000L, timeoutMillis / 4L))
        task = scheduler?.scheduleWithFixedDelay(
            {
                if (active && !closed && nanoTime() - lastProgressNanos >= timeoutNanos) {
                    active = false
                    runCatching(onTimeout)
                }
            },
            periodMillis,
            periodMillis,
            TimeUnit.MILLISECONDS,
        )
    }

    fun start() {
        if (closed || active) return
        lastProgressNanos = nanoTime()
        active = true
    }

    fun progress() {
        if (active && !closed) lastProgressNanos = nanoTime()
    }

    override fun close() {
        closed = true
        active = false
        task?.cancel(false)
    }
}
