package com.localis.xrserver.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class RequestSecurityTest {
    @Test
    fun parsesAndChecksAllowedAuthoritiesWithoutTrustingThePort() {
        assertEquals(HttpAuthority("localhost", 8080), RequestSecurity.parseAuthority("localhost:8080"))
        assertEquals(HttpAuthority("::1", 8443), RequestSecurity.parseAuthority("[::1]:8443"))
        assertTrue(RequestSecurity.isAllowedHost("LOCALHOST:8080", setOf("localhost")))
        assertTrue(RequestSecurity.isAllowedHost("[::1]:8080", setOf("::1")))
        assertFalse(RequestSecurity.isAllowedHost("attacker.example", setOf("localhost", "127.0.0.1")))
        assertNull(RequestSecurity.parseAuthority("user@localhost"))
        assertNull(RequestSecurity.parseAuthority("::1:8080"))
        assertNull(RequestSecurity.parseAuthority("localhost:0"))
    }

    @Test
    fun requiresTheSemanticOriginToMatchSchemeHostAndPortExactly() {
        assertTrue(RequestSecurity.originMatches("http", "localhost:8080", "http://localhost:8080"))
        assertTrue(RequestSecurity.originMatches("https", "example.test", "https://example.test:443"))
        assertTrue(RequestSecurity.originMatches("http", "[::1]:8080", "http://[::1]:8080"))
        assertFalse(RequestSecurity.originMatches("http", "localhost:8080", "https://localhost:8080"))
        assertFalse(RequestSecurity.originMatches("http", "localhost:8080", "http://localhost:8081"))
        assertFalse(RequestSecurity.originMatches("http", "localhost:8080", "http://attacker.example:8080"))
        assertFalse(RequestSecurity.originMatches("http", "localhost:8080", "http://localhost:8080/path"))
        assertFalse(RequestSecurity.originMatches("http", "localhost:8080", "not-an-origin"))
    }

    @Test
    fun mapsLocalAndConfiguredPublicAuthoritiesToExactPorts() {
        assertTrue(
            RequestSecurity.isAllowedLocalAuthority(
                "192.168.1.20:8081",
                setOf("192.168.1.20", "localhost"),
                "http",
                8081,
            ),
        )
        assertFalse(
            RequestSecurity.isAllowedLocalAuthority(
                "192.168.1.20:8082",
                setOf("192.168.1.20"),
                "http",
                8081,
            ),
        )
        assertTrue(RequestSecurity.authorityMatchesConfiguredOrigin("xr.example.test", "https://xr.example.test"))
        assertTrue(RequestSecurity.authorityMatchesConfiguredOrigin("xr.example.test:443", "https://xr.example.test"))
        assertFalse(RequestSecurity.authorityMatchesConfiguredOrigin("xr.example.test:444", "https://xr.example.test"))
        assertFalse(RequestSecurity.authorityMatchesConfiguredOrigin("other.example.test", "https://xr.example.test"))
        assertNull(RequestSecurity.parseOrigin("http://user@xr.example.test"))
        assertNull(RequestSecurity.parseOrigin("https://xr.example.test/path"))
        assertNull(RequestSecurity.parseOrigin("https://xr.example.test?query=1"))
    }

    @Test
    fun serverConfigAcceptsOnlyAnExactHttpsPublicOrigin() {
        assertEquals("https://xr.example.test", HttpServerConfig(publicUrl = "https://xr.example.test").publicUrl)
        for (origin in listOf(
            "http://xr.example.test",
            "https://user@xr.example.test",
            "https://xr.example.test/path",
            "https://xr.example.test?query=1",
            "https://xr.example.test#fragment",
        )) {
            assertThrows(origin, IllegalArgumentException::class.java) {
                HttpServerConfig(publicUrl = origin)
            }
        }
    }
}
