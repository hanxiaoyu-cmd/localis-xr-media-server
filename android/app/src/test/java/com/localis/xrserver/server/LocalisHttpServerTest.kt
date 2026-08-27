package com.localis.xrserver.server

import com.localis.xrserver.data.MediaPatch
import com.localis.xrserver.data.PlaybackProgress
import com.localis.xrserver.data.PublicMediaItem
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class LocalisHttpServerTest {
    private lateinit var backend: TestBackend
    private lateinit var server: LocalisHttpServer
    private lateinit var binding: ServerBinding

    @Before
    fun setUp() {
        backend = TestBackend()
        server = createServer(backend)
        binding = server.start()
    }

    @After
    fun tearDown() {
        server.stop()
    }

    @Test
    fun servesStaticAssetsAndPublicHealthBeforePairing() {
        val root = exchange(request("GET", "/"))
        assertEquals(200, root.status)
        assertEquals("close", root.headers["connection"])
        assertTrue(root.headers["content-security-policy"].orEmpty().contains("default-src 'self'"))
        assertTrue(root.body.toString(StandardCharsets.UTF_8).contains("href=\"/styles.css\""))

        val fallback = exchange(request("GET", "/watch/movie"))
        assertEquals(200, fallback.status)
        assertEquals("no-cache", fallback.headers["cache-control"])

        val stylesheet = exchange(request("GET", "/styles.css"))
        assertEquals(200, stylesheet.status)
        assertEquals("text/css; charset=utf-8", stylesheet.headers["content-type"])

        val health = exchange(request("GET", "/api/health"))
        assertEquals(200, health.status)
        assertTrue(health.body.toString(StandardCharsets.UTF_8).contains("\"service\":\"localis\""))
    }

    @Test
    fun enforcesHostOriginPairingAndProtectedApiContracts() {
        val rejectedHost = exchange(request("GET", "/api/health", host = "attacker.example"))
        assertEquals(421, rejectedHost.status)
        assertTrue(rejectedHost.body.toString(StandardCharsets.UTF_8).contains("unrecognized_host"))
        assertEquals(421, exchange(request("GET", "/api/health", host = "localhost:${binding.port + 1}")).status)

        assertEquals(401, exchange(request("GET", "/api/library")).status)

        val pairBody = "{\"code\":\"123456\"}"
        val missingOrigin = exchange(request("POST", "/api/pair/verify", body = pairBody))
        assertEquals(403, missingOrigin.status)
        assertTrue(missingOrigin.body.toString(StandardCharsets.UTF_8).contains("origin_required"))

        val wrongOrigin = exchange(
            request(
                "POST",
                "/api/pair/verify",
                headers = mapOf("Origin" to "http://localhost:${binding.port + 1}"),
                body = pairBody,
            ),
        )
        assertEquals(403, wrongOrigin.status)

        val invalid = exchange(
            request(
                "POST",
                "/api/pair/verify",
                headers = mapOf("Origin" to origin()),
                body = "{\"code\":\"000000\"}",
            ),
        )
        assertEquals(401, invalid.status)
        assertTrue(invalid.body.toString(StandardCharsets.UTF_8).contains("\"attemptsRemaining\":4"))

        val paired = pair()
        assertEquals(200, paired.status)
        val cookie = paired.headers["set-cookie"].orEmpty().substringBefore(';')
        assertEquals("localis_session=test-session", cookie)
        assertTrue(paired.headers["set-cookie"].orEmpty().contains("HttpOnly"))
        assertFalse(paired.headers["set-cookie"].orEmpty().contains("Secure"))

        val library = exchange(request("GET", "/api/library", headers = mapOf("Cookie" to cookie)))
        assertEquals(200, library.status)
        assertTrue(library.body.toString(StandardCharsets.UTF_8).contains("\"id\":\"movie\""))

        val detail = exchange(request("GET", "/api/media/movie", headers = mapOf("Cookie" to cookie)))
        assertEquals(200, detail.status)
        val detailJson = detail.body.toString(StandardCharsets.UTF_8)
        assertTrue(detailJson.contains("\"mode\":\"direct\""))
        assertTrue(detailJson.contains("\"seekable\":true"))
        assertTrue(detailJson.contains("\"available\":false"))

        val patch = exchange(
            request(
                "PATCH",
                "/api/media/movie",
                headers = mapOf("Cookie" to cookie, "Origin" to origin()),
                body = "{\"projection\":\"equirect180\",\"yawOffset\":99}",
            ),
        )
        assertEquals(200, patch.status)
        assertEquals("equirect180", backend.findMedia("movie")?.projection)
        assertEquals(Math.PI * 2, backend.findMedia("movie")?.yawOffset ?: 0.0, 0.0001)

        val progress = exchange(
            request(
                "PUT",
                "/api/progress/movie",
                headers = mapOf("Cookie" to cookie, "Origin" to origin()),
                body = "{\"position\":12.5,\"duration\":120}",
            ),
        )
        assertEquals(200, progress.status)
        assertEquals(12.5, backend.findProgress("movie")?.position ?: 0.0, 0.001)

        val refreshed = exchange(
            request(
                "POST",
                "/api/library/refresh",
                headers = mapOf("Cookie" to cookie, "Origin" to origin()),
                body = "{}",
            ),
        )
        assertEquals(200, refreshed.status)
        assertEquals(1, backend.refreshes)
    }

    @Test
    fun supportsAnExplicitHttpsReverseProxyOriginWithoutTrustingForwardedHeaders() {
        server.stop()
        server = createServer(backend, publicUrl = "https://xr.example.test")
        binding = server.start()

        val publicHost = "xr.example.test"
        val publicOrigin = "https://xr.example.test"
        val paired = exchange(
            request(
                "POST",
                "/api/pair/verify",
                headers = mapOf(
                    "Origin" to publicOrigin,
                    "Forwarded" to "host=attacker.test;proto=http",
                    "X-Forwarded-Host" to "attacker.test",
                    "X-Forwarded-Proto" to "http",
                ),
                body = "{\"code\":\"123456\"}",
                host = publicHost,
            ),
        )
        assertEquals(200, paired.status)
        assertTrue(paired.headers["set-cookie"].orEmpty().contains("; Secure"))
        val cookie = paired.headers["set-cookie"].orEmpty().substringBefore(';')

        val publicInfo = exchange(request("GET", "/api/server", mapOf("Cookie" to cookie), host = publicHost))
        assertEquals(200, publicInfo.status)
        assertTrue(publicInfo.body.toString(StandardCharsets.UTF_8).contains("\"secure\":true"))
        assertTrue(publicInfo.body.toString(StandardCharsets.UTF_8).contains("\"port\":443"))

        val wrongScheme = exchange(
            request(
                "POST",
                "/api/pair/verify",
                headers = mapOf("Origin" to "http://xr.example.test"),
                body = "{\"code\":\"123456\"}",
                host = publicHost,
            ),
        )
        assertEquals(403, wrongScheme.status)

        val crossedOrigins = exchange(
            request(
                "POST",
                "/api/pair/verify",
                headers = mapOf("Origin" to publicOrigin),
                body = "{\"code\":\"123456\"}",
            ),
        )
        assertEquals(403, crossedOrigins.status)
        assertEquals(421, exchange(request("GET", "/api/health", host = "xr.example.test:444")).status)
        assertEquals(421, exchange(request("GET", "/api/health", host = "other.example.test")).status)

        val direct = pair()
        assertEquals(200, direct.status)
        assertFalse(direct.headers["set-cookie"].orEmpty().contains("; Secure"))
    }

    @Test
    fun acceptsBoundedChunkedJsonFromAnHttpReverseProxy() {
        val body = "{\"code\":\"123456\"}"
        val chunked = raw(
            "POST /api/pair/verify HTTP/1.1\r\n" +
                "Host: localhost:${binding.port}\r\n" +
                "Origin: ${origin()}\r\n" +
                "Content-Type: application/json\r\n" +
                "Transfer-Encoding: chunked\r\n\r\n" +
                "${body.toByteArray().size.toString(16)}\r\n$body\r\n0\r\n\r\n",
        )
        assertEquals(200, exchange(chunked).status)
    }

    @Test
    fun streamsFixedAndHeadRangesAndHonorsIfRange() {
        val cookie = pair().headers["set-cookie"].orEmpty().substringBefore(';')
        val authHeader = mapOf("Cookie" to cookie)

        val fixed = exchange(
            request("GET", "/api/media/movie/stream", authHeader + ("Range" to "bytes=2-5")),
        )
        assertEquals(206, fixed.status)
        assertEquals("bytes 2-5/16", fixed.headers["content-range"])
        assertEquals("4", fixed.headers["content-length"])
        assertArrayEquals("2345".toByteArray(), fixed.body)

        val head = exchange(
            request("HEAD", "/api/media/movie/stream", authHeader + ("Range" to "bytes=0-3")),
        )
        assertEquals(206, head.status)
        assertEquals("4", head.headers["content-length"])
        assertEquals(0, head.body.size)

        val invalid = exchange(
            request("GET", "/api/media/movie/stream", authHeader + ("Range" to "bytes=16-")),
        )
        assertEquals(416, invalid.status)
        assertEquals("bytes */16", invalid.headers["content-range"])

        val stale = exchange(
            request(
                "GET",
                "/api/media/movie/stream",
                authHeader + mapOf("Range" to "bytes=0-3", "If-Range" to "\"stale\""),
            ),
        )
        assertEquals(200, stale.status)
        assertArrayEquals(backend.bytes, stale.body)

        val matching = exchange(
            request(
                "GET",
                "/api/media/movie/stream",
                authHeader + mapOf("Range" to "bytes=0-3", "If-Range" to "\"media-v1\""),
            ),
        )
        assertEquals(206, matching.status)
        assertArrayEquals("0123".toByteArray(), matching.body)

        val weak = exchange(
            request(
                "GET",
                "/api/media/movie/stream",
                authHeader + mapOf("Range" to "bytes=0-3", "If-Range" to "W/\"media-v1\""),
            ),
        )
        assertEquals(200, weak.status)

        val olderDate = exchange(
            request(
                "GET",
                "/api/media/movie/stream",
                authHeader + mapOf("Range" to "bytes=0-3", "If-Range" to "Mon, 01 Jan 2024 00:00:00 GMT"),
            ),
        )
        assertEquals(206, olderDate.status)

        val staleDate = exchange(
            request(
                "GET",
                "/api/media/movie/stream",
                authHeader + mapOf("Range" to "bytes=0-3", "If-Range" to "Sun, 31 Dec 2023 23:59:59 GMT"),
            ),
        )
        assertEquals(200, staleDate.status)
    }

    @Test
    fun boundsRequestLineHeadersAndBodyBeforeAllocationOrRouting() {
        val longTarget = "/" + "a".repeat(9_000)
        assertEquals(414, exchange(request("GET", longTarget)).status)

        val largeHeader = request("GET", "/", headers = mapOf("X-Fill" to "b".repeat(33_000)))
        assertEquals(431, exchange(largeHeader).status)

        val declaredLargeBody = raw(
            "POST /api/pair/verify HTTP/1.1\r\n" +
                "Host: localhost:${binding.port}\r\n" +
                "Origin: ${origin()}\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: 40000\r\n\r\n",
        )
        assertEquals(413, exchange(declaredLargeBody).status)

        val signedLength = raw(
            "POST /api/pair/verify HTTP/1.1\r\n" +
                "Host: localhost:${binding.port}\r\n" +
                "Origin: ${origin()}\r\n" +
                "Content-Type: application/json\r\n" +
                "Content-Length: +1\r\n\r\n0",
        )
        assertEquals(400, exchange(signedLength).status)

        val duplicateHost = raw(
            "GET /api/health HTTP/1.1\r\n" +
                "Host: localhost:${binding.port}\r\n" +
                "Host: attacker.test\r\n\r\n",
        )
        assertEquals(400, exchange(duplicateHost).status)

        val ambiguousLength = raw(
            "POST /api/pair/verify HTTP/1.1\r\n" +
                "Host: localhost:${binding.port}\r\n" +
                "Origin: ${origin()}\r\n" +
                "Content-Type: application/json\r\n" +
                "Transfer-Encoding: chunked\r\n" +
                "Content-Length: 1\r\n\r\n0\r\n\r\n",
        )
        assertEquals(400, exchange(ambiguousLength).status)
    }

    @Test
    fun rejectsConnectionsBeyondTheConfiguredConcurrencyWithoutQueuing() {
        server.stop()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        backend = TestBackend(entered, release)
        server = createServer(backend, maxConcurrentConnections = 1)
        binding = server.start()
        val executor = Executors.newSingleThreadExecutor()
        try {
            val first = executor.submit<RawResponse> { exchange(request("GET", "/")) }
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            val busy = exchange(request("GET", "/api/health"))
            assertEquals(503, busy.status)
            assertEquals("1", busy.headers["retry-after"])
            release.countDown()
            assertEquals(200, first.get(2, TimeUnit.SECONDS).status)
        } finally {
            release.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun stoppingAndRestartingInvalidatesEveryCookie() {
        val cookie = pair().headers["set-cookie"].orEmpty().substringBefore(';')
        assertEquals(200, exchange(request("GET", "/api/library", mapOf("Cookie" to cookie))).status)
        server.stop()
        binding = server.start()
        assertEquals(401, exchange(request("GET", "/api/library", mapOf("Cookie" to cookie))).status)
    }

    private fun createServer(
        backend: TestBackend,
        maxConcurrentConnections: Int = 4,
        publicUrl: String? = null,
    ): LocalisHttpServer =
        LocalisHttpServer(
            config = HttpServerConfig(
                bindAddress = InetAddress.getByName("127.0.0.1"),
                allowedHosts = setOf("localhost", "127.0.0.1"),
                maxConcurrentConnections = maxConcurrentConnections,
                maxConcurrentMediaStreams = maxConcurrentConnections.coerceAtMost(2),
                socketReadTimeoutMillis = 3_000,
                publicUrl = publicUrl,
            ),
            backend = backend,
            auth = PairingSessionManager(
                pairingCodeFactory = { "123456" },
                tokenFactory = { "test-session" },
            ),
            clock = { 1_700_000_000_000L },
        )

    private fun pair(): RawResponse = exchange(
        request(
            "POST",
            "/api/pair/verify",
            headers = mapOf("Origin" to origin()),
            body = "{\"code\":\"123456\"}",
        ),
    )

    private fun origin(): String = "http://localhost:${binding.port}"

    private fun request(
        method: String,
        path: String,
        headers: Map<String, String> = emptyMap(),
        body: String = "",
        host: String = "localhost:${binding.port}",
    ): ByteArray = buildString {
        append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
        append("Host: ").append(host).append("\r\n")
        headers.forEach { (name, value) -> append(name).append(": ").append(value).append("\r\n") }
        if (body.isNotEmpty()) {
            append("Content-Type: application/json\r\n")
            append("Content-Length: ").append(body.toByteArray(StandardCharsets.UTF_8).size).append("\r\n")
        }
        append("\r\n")
        append(body)
    }.toByteArray(StandardCharsets.UTF_8)

    private fun raw(value: String): ByteArray = value.toByteArray(StandardCharsets.ISO_8859_1)

    private fun exchange(request: ByteArray): RawResponse = Socket("127.0.0.1", binding.port).use { socket ->
        socket.soTimeout = 4_000
        socket.getOutputStream().write(request)
        socket.getOutputStream().flush()
        socket.shutdownOutput()
        RawResponse.parse(socket.getInputStream().readBytes())
    }
}

private data class RawResponse(
    val status: Int,
    val headers: Map<String, String>,
    val body: ByteArray,
) {
    companion object {
        fun parse(bytes: ByteArray): RawResponse {
            val marker = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())
            val headerEnd = bytes.indexOfSubsequence(marker)
            assertTrue("Response must contain a complete header block", headerEnd >= 0)
            val headerText = String(bytes, 0, headerEnd, StandardCharsets.ISO_8859_1)
            val lines = headerText.split("\r\n")
            val status = lines.first().split(' ')[1].toInt()
            val headers = lines.drop(1).associate { line ->
                val separator = line.indexOf(':')
                line.substring(0, separator).lowercase() to line.substring(separator + 1).trim()
            }
            val bodyStart = headerEnd + marker.size
            return RawResponse(status, headers, bytes.copyOfRange(bodyStart, bytes.size))
        }

        private fun ByteArray.indexOfSubsequence(needle: ByteArray): Int {
            for (start in 0..size - needle.size) {
                if (needle.indices.all { index -> this[start + index] == needle[index] }) return start
            }
            return -1
        }
    }
}

private class TestBackend(
    private val staticEntered: CountDownLatch? = null,
    private val staticRelease: CountDownLatch? = null,
) : MediaServerBackend {
    val bytes = "0123456789abcdef".toByteArray()
    private val progress = ConcurrentHashMap<String, PlaybackProgress>()

    @Volatile
    private var item = PublicMediaItem(
        id = "movie",
        kind = "video",
        title = "Movie",
        fileName = "movie.mp4",
        relativePath = "movie.mp4",
        extension = ".mp4",
        size = bytes.size.toLong(),
        modifiedAt = "2024-01-01T00:00:00Z",
        duration = 120.0,
        width = 1920,
        height = 1080,
        videoCodec = "h264",
        audioCodec = "aac",
        streamUrl = "/api/media/movie/stream",
    )

    @Volatile
    var refreshes = 0
        private set

    override val mediaRootCount: Int = 1

    override val staticAssets = StaticAssetBackend { path ->
        val (body, contentType) = when (path) {
            "index.html" -> "<html><link rel=\"stylesheet\" href=\"/styles.css\"></html>" to "text/html; charset=utf-8"
            "styles.css" -> "body{background:#000}" to "text/css; charset=utf-8"
            else -> return@StaticAssetBackend null
        }
        staticEntered?.countDown()
        staticRelease?.await(2, TimeUnit.SECONDS)
        val content = body.toByteArray()
        StaticAsset(
            length = content.size.toLong(),
            contentType = contentType,
            etag = "$path-v1",
            cacheControl = if (path == "index.html") "no-cache" else "public, max-age=3600",
            open = { ByteArrayInputStream(content) },
        )
    }

    override fun listMedia(): List<PublicMediaItem> = listOf(item)

    override fun refreshMedia(): List<PublicMediaItem> {
        refreshes += 1
        return listMedia()
    }

    override fun findMedia(id: String): PublicMediaItem? = item.takeIf { it.id == id }

    override fun updateMedia(id: String, patch: MediaPatch): PublicMediaItem? {
        if (id != item.id) return null
        synchronized(this) {
            item = item.copy(
                projection = patch.projection ?: item.projection,
                stereo = patch.stereo ?: item.stereo,
                eyeOrder = patch.eyeOrder ?: item.eyeOrder,
                yawOffset = patch.yawOffset ?: item.yawOffset,
                title = patch.title ?: item.title,
            )
            return item
        }
    }

    override fun listProgress(): Map<String, PlaybackProgress> = progress.toMap()

    override fun findProgress(id: String): PlaybackProgress? = progress[id]

    override fun saveProgress(progress: PlaybackProgress): PlaybackProgress = progress.also {
        this.progress[it.mediaId] = it
    }

    override fun openMedia(id: String): MediaContent? {
        if (id != item.id) return null
        return MediaContent(
            item = item,
            length = bytes.size.toLong(),
            contentType = "video/mp4",
            lastModifiedEpochMillis = 1_704_067_200_000L,
            etag = "media-v1",
            openAt = { offset ->
                ByteArrayInputStream(bytes, offset.toInt(), bytes.size - offset.toInt())
            },
        )
    }
}
