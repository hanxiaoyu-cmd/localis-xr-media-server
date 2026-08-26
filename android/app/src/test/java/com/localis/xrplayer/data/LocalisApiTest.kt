package com.localis.xrplayer.data

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class LocalisApiTest {
    private lateinit var server: MockWebServer
    private lateinit var originStore: TestOriginStore
    private lateinit var api: LocalisApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        originStore = TestOriginStore(server.url("/"))
        val cookieJar = PersistentCookieJar(MemoryApiCookiePersistence())
        val client = OkHttpClient.Builder()
            .cookieJar(cookieJar)
            .addInterceptor(OriginInterceptor(originStore::get))
            .addInterceptor(PlaybackPathPolicyInterceptor(originStore::get))
            .build()
        api = LocalisApi(client, originStore)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `pairs persists cookie loads library and writes progress with Origin`() = runBlocking {
        server.enqueue(MockResponse().setBody("{\"paired\":false,\"pairingRequired\":true}"))
        server.enqueue(
            MockResponse()
                .addHeader("Set-Cookie", "localis_session=signed; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict")
                .setBody("{\"paired\":true}"),
        )
        server.enqueue(MockResponse().setBody("{\"items\":[],\"progress\":{}}"))
        server.enqueue(
            MockResponse().setBody(
                "{\"progress\":{\"mediaId\":\"movie\",\"position\":12.5,\"duration\":120.0,\"updatedAt\":\"2026-08-26T00:00:00.000Z\"}}",
            ),
        )

        assertTrue(api.pairStatus().pairingRequired)
        assertTrue(api.verifyPairing("123456").paired)
        assertTrue(api.library().items.isEmpty())
        assertEquals(12.5, api.saveProgress("movie", 12.5, 120.0).position, 0.001)

        val status = server.takeRequest()
        val verify = server.takeRequest()
        val library = server.takeRequest()
        val progress = server.takeRequest()
        assertEquals("/api/pair/status", status.path)
        assertEquals(ServerAddress.origin(server.url("/")), verify.getHeader("Origin"))
        assertTrue(library.getHeader("Cookie").orEmpty().contains("localis_session=signed"))
        assertEquals(ServerAddress.origin(server.url("/")), progress.getHeader("Origin"))
    }

    @Test
    fun `waits for a valid compatibility manifest before returning playback URL`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(202).addHeader("Retry-After", "1").setBody("{\"state\":\"running\"}"))
        server.enqueue(
            MockResponse()
                .addHeader("Content-Type", "application/vnd.apple.mpegurl")
                .setBody("#EXTM3U\n#EXT-X-VERSION:7\n"),
        )

        val manifest = api.awaitCompatibilityManifest("movie", maxAttempts = 2)
        assertEquals("/api/media/movie/hls/compat/index.m3u8", manifest.encodedPath)
        assertEquals(manifest.encodedPath, server.takeRequest().requestUrl?.encodedPath)
        assertEquals(manifest.encodedPath, server.takeRequest().requestUrl?.encodedPath)
    }

    @Test
    fun `rejects an oversized chunked compatibility manifest`() = runBlocking {
        server.enqueue(
            MockResponse()
                .addHeader("Content-Type", "application/vnd.apple.mpegurl")
                .setChunkedBody("#EXTM3U\n" + "x".repeat(512 * 1024), 4 * 1024),
        )

        val failure = runCatching { api.awaitCompatibilityManifest("movie", maxAttempts = 1) }.exceptionOrNull()
        assertNotNull(failure)
        assertTrue(failure?.message.orEmpty().contains("响应过大"))
    }

    @Test
    fun `rejects an oversized chunked small API response`() = runBlocking {
        server.enqueue(MockResponse().setChunkedBody("x".repeat(64 * 1024 + 1), 4 * 1024))

        val failure = runCatching { api.health() }.exceptionOrNull()

        assertNotNull(failure)
        assertTrue(failure?.message.orEmpty().contains("响应过大"))
    }
}

private class TestOriginStore(private var value: HttpUrl?) : ServerOriginStore {
    override fun get(): HttpUrl? = value
    override fun set(value: HttpUrl) {
        this.value = value
    }
}

private class MemoryApiCookiePersistence : CookiePersistence {
    private var cookies: List<StoredCookie> = emptyList()
    override fun load(): List<StoredCookie> = cookies
    override fun save(cookies: List<StoredCookie>) {
        this.cookies = cookies
    }
}
