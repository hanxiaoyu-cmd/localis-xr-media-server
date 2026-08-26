package com.localis.xrplayer.data

import java.io.IOException
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class NetworkPolicyTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `adds exact Origin to writes and leaves GET unchanged`() {
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setBody("{}"))
        val origin = server.url("/")
        val client = OkHttpClient.Builder().addInterceptor(OriginInterceptor { origin }).build()

        client.newCall(Request.Builder().url(server.url("/api/pair/verify")).post("{}".toRequestBody()).build())
            .execute().close()
        client.newCall(Request.Builder().url(server.url("/api/pair/status")).get().build())
            .execute().close()

        assertEquals(ServerAddress.origin(origin), server.takeRequest().getHeader("Origin"))
        assertNull(server.takeRequest().getHeader("Origin"))
    }

    @Test
    fun `persists session cookies across jar recreation`() {
        val persistence = MemoryCookiePersistence()
        val cookie = Cookie.Builder()
            .name("localis_session")
            .value("signed-session")
            .hostOnlyDomain(server.url("/").host)
            .path("/")
            .httpOnly()
            .expiresAt(System.currentTimeMillis() + 60_000)
            .build()
        PersistentCookieJar(persistence).saveFromResponse(server.url("/"), listOf(cookie))

        val restored = PersistentCookieJar(persistence).loadForRequest(server.url("/api/library"))
        assertEquals("signed-session", restored.single().value)
    }

    @Test
    fun `binds persisted session cookies to the exact server origin`() {
        val persistence = MemoryCookiePersistence()
        val origin = server.url("/")
        val cookie = Cookie.Builder()
            .name("localis_session")
            .value("signed-session")
            .hostOnlyDomain(origin.host)
            .path("/")
            .expiresAt(System.currentTimeMillis() + 60_000)
            .build()
        PersistentCookieJar(persistence).saveFromResponse(origin, listOf(cookie))

        val otherPort = origin.newBuilder()
            .port(if (origin.port == 65_535) origin.port - 1 else origin.port + 1)
            .build()
        val restored = PersistentCookieJar(persistence)
        assertTrue(restored.loadForRequest(origin).isNotEmpty())
        assertTrue(restored.loadForRequest(otherPort).isEmpty())
    }

    @Test
    fun `blocks every HLS route except compat`() {
        server.enqueue(MockResponse().setBody("#EXTM3U"))
        val origin = server.url("/")
        val client = OkHttpClient.Builder().addInterceptor(PlaybackPathPolicyInterceptor { origin }).build()
        client.newCall(Request.Builder().url(server.url("/api/media/id/hls/compat/index.m3u8")).build())
            .execute().close()

        for (level in listOf("off", "standard", "high", "ultra", "ai")) {
            val failure = assertThrows(IOException::class.java) {
                client.newCall(Request.Builder().url(server.url("/api/media/id/hls/$level/index.m3u8")).build())
                    .execute().close()
            }
            assertTrue(failure.message.orEmpty().contains("阻止"))
        }
    }

    @Test
    fun `blocks media requests to a different origin`() {
        val origin = server.url("/")
        val otherPort = origin.newBuilder()
            .port(if (origin.port == 65_535) origin.port - 1 else origin.port + 1)
            .build()
        val client = OkHttpClient.Builder()
            .addInterceptor(PlaybackPathPolicyInterceptor { origin })
            .build()

        val failure = assertThrows(IOException::class.java) {
            client.newCall(
                Request.Builder()
                    .url(otherPort.resolve("/api/media/id/hls/compat/index.m3u8")!!)
                    .build(),
            ).execute().close()
        }
        assertTrue(failure.message.orEmpty().contains("跨来源"))
    }
}

private class MemoryCookiePersistence : CookiePersistence {
    private var cookies: List<StoredCookie> = emptyList()
    override fun load(): List<StoredCookie> = cookies
    override fun save(cookies: List<StoredCookie>) {
        this.cookies = cookies
    }
}
