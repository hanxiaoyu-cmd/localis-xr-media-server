package com.localis.xrplayer.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ServerAddressTest {
    @Test
    fun `normalizes private LAN and secure public origins`() {
        assertEquals("http://192.168.1.20:8081", ServerAddress.origin(ServerAddress.normalize("192.168.1.20:8081")))
        assertEquals("http://10.0.2.2:8081", ServerAddress.origin(ServerAddress.normalize("http://10.0.2.2:8081/")))
        assertEquals("https://media.example.com", ServerAddress.origin(ServerAddress.normalize("https://media.example.com")))
    }

    @Test
    fun `rejects insecure public hosts and non-root addresses`() {
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.normalize("http://media.example.com:8081") }
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.normalize("http://192.168.1.2:8081/api") }
        assertThrows(IllegalArgumentException::class.java) { ServerAddress.normalize("http://user:pass@192.168.1.2:8081") }
    }

    @Test
    fun `builds only direct and compatibility playback sources`() {
        val origin = ServerAddress.normalize("http://192.168.50.5:8081")
        val direct = ServerAddress.resolveSameOrigin(origin, "/api/media/movie-id/stream")
        val compatibility = ServerAddress.compatibilityManifest(origin, "movie/id")

        assertEquals("/api/media/movie-id/stream", direct.encodedPath)
        assertEquals("/api/media/movie%2Fid/hls/compat/index.m3u8", compatibility.encodedPath)
    }
}
