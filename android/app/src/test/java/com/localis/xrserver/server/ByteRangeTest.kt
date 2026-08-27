package com.localis.xrserver.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class ByteRangeTest {
    @Test
    fun parsesFixedOpenEndedAndSuffixRanges() {
        assertEquals(ByteRange(2, 5), ByteRanges.parse("bytes=2-5", 10))
        assertEquals(ByteRange(7, 9), ByteRanges.parse("bytes=7-", 10))
        assertEquals(ByteRange(6, 9), ByteRanges.parse("bytes=-4", 10))
        assertEquals(ByteRange(0, 9), ByteRanges.parse("bytes=-100", 10))
        assertEquals(ByteRange(8, 9), ByteRanges.parse("bytes=8-100", 10))
        assertNull(ByteRanges.parse(null, 10))
    }

    @Test
    fun rejectsMultipleMalformedAndUnsatisfiableRanges() {
        for (value in listOf("bytes=", "bytes=1-2,4-5", "items=0-1", "bytes=5-2", "bytes=10-", "bytes=-0")) {
            assertThrows(value, RangeNotSatisfiableException::class.java) {
                ByteRanges.parse(value, 10)
            }
        }
        assertThrows(RangeNotSatisfiableException::class.java) {
            ByteRanges.parse("bytes=0-0", 0)
        }
    }
}
