package com.localis.xrserver.server

import java.io.ByteArrayInputStream
import java.net.SocketTimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class HttpProtocolTest {
    @Test
    fun enforcesAnAbsoluteRequestReadDeadline() {
        var now = 1_000L
        val remainingTimeouts = mutableListOf<Int>()
        val input = DeadlineInputStream(
            source = ByteArrayInputStream(byteArrayOf(1, 2)),
            timeoutMillis = 1_000,
            nanoTime = { now },
            beforeBlockingRead = remainingTimeouts::add,
        )
        assertEquals(1, input.read())
        assertEquals(listOf(1_000), remainingTimeouts)
        now += 1_000_000_000L
        assertThrows(SocketTimeoutException::class.java) { input.read() }
    }
}
