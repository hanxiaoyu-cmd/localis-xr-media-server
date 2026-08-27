package com.localis.xrserver.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingSessionManagerTest {
    @Test
    fun issuesAnOpaqueMemorySessionAndInvalidatesItOnStopOrExpiry() {
        var now = 1_000L
        val manager = PairingSessionManager(
            clock = { now },
            pairingCodeFactory = { "123456" },
            tokenFactory = { "opaque-token" },
            sessionLifetimeMillis = 10_000,
        )
        manager.startNewEpoch()
        val success = manager.verify("123456", "192.168.1.10") as PairingResult.Success
        assertEquals("opaque-token", success.token)
        assertTrue(manager.authenticate("theme=dark; localis_session=opaque-token"))
        assertFalse(manager.authenticate("localis_session=other"))

        now += 10_001
        assertFalse(manager.authenticate("localis_session=opaque-token"))

        now += 1
        manager.verify("123456", "192.168.1.10") as PairingResult.Success
        manager.invalidateAll()
        assertFalse(manager.authenticate("localis_session=opaque-token"))
    }

    @Test
    fun rateLimitsEachAddressAndResetsAfterTheWindow() {
        var now = 0L
        val manager = PairingSessionManager(
            clock = { now },
            pairingCodeFactory = { "123456" },
            tokenFactory = { "token" },
            attemptWindowMillis = 300_000,
            maxAttemptsPerAddress = 5,
        )
        manager.startNewEpoch()
        for (remaining in 4 downTo 0) {
            assertEquals(remaining, (manager.verify("000000", "client") as PairingResult.Invalid).attemptsRemaining)
        }
        assertEquals(300, (manager.verify("123456", "client") as PairingResult.RateLimited).retryAfterSeconds)
        now = 300_000
        assertTrue(manager.verify("123456", "client") is PairingResult.Success)
    }

    @Test
    fun appliesTheGlobalInvalidAttemptLimitAcrossAddresses() {
        val manager = PairingSessionManager(
            pairingCodeFactory = { "123456" },
            tokenFactory = { "token" },
            maxGlobalAttempts = 2,
        )
        manager.startNewEpoch()
        assertTrue(manager.verify("000000", "one") is PairingResult.Invalid)
        assertTrue(manager.verify("000000", "two") is PairingResult.Invalid)
        assertTrue(manager.verify("123456", "three") is PairingResult.RateLimited)
    }

    @Test
    fun boundsTheNumberOfLongLivedSessions() {
        var sequence = 0
        val manager = PairingSessionManager(
            pairingCodeFactory = { "123456" },
            tokenFactory = { "token-${++sequence}" },
            maxSessions = 2,
        )
        manager.startNewEpoch()
        manager.verify("123456", "one") as PairingResult.Success
        manager.verify("123456", "two") as PairingResult.Success
        manager.verify("123456", "three") as PairingResult.Success

        assertFalse(manager.authenticate("localis_session=token-1"))
        assertTrue(manager.authenticate("localis_session=token-2"))
        assertTrue(manager.authenticate("localis_session=token-3"))
    }
}
