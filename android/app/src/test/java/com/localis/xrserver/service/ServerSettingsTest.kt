package com.localis.xrserver.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class ServerSettingsTest {
    @Test
    fun resolvesTheStableDefaultPortAndNormalizesAnHttpsOrigin() {
        val defaults = ServerSettings().resolve()
        assertEquals(8_081, defaults.port)
        assertNull(defaults.externalOrigin)

        val configured = ServerSettings(
            portText = "9443",
            externalOriginText = "  HTTPS://XR.Example.Test/  ",
        ).resolve()
        assertEquals(9_443, configured.port)
        assertEquals("https://xr.example.test", configured.externalOrigin)
    }

    @Test
    fun rejectsUnsafeOrAmbiguousListenerSettings() {
        for (port in listOf("", "80", "65536", "abc")) {
            assertThrows(IllegalArgumentException::class.java) {
                ServerSettings(portText = port).resolve()
            }
        }
        for (origin in listOf(
            "http://xr.example.test",
            "https://user@xr.example.test",
            "https://xr.example.test/path",
            "https://xr.example.test?query=1",
            "https://xr.example.test#fragment",
            "https://xr.example.test:0",
        )) {
            assertThrows(origin, IllegalArgumentException::class.java) {
                ServerSettings(externalOriginText = origin).resolve()
            }
        }
    }
}
