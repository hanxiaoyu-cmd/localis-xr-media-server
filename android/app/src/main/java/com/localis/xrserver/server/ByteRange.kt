package com.localis.xrserver.server

data class ByteRange(val start: Long, val endInclusive: Long) {
    init {
        require(start >= 0 && endInclusive >= start)
    }

    val length: Long get() = endInclusive - start + 1
}

class RangeNotSatisfiableException(message: String) : IllegalArgumentException(message)

object ByteRanges {
    /** Parses the single RFC 7233 byte range supported by Localis. */
    fun parse(header: String?, size: Long): ByteRange? {
        if (header == null) return null
        if (size < 0 || !header.startsWith("bytes=")) {
            throw RangeNotSatisfiableException("Invalid range")
        }
        val value = header.removePrefix("bytes=").trim()
        if (value.isEmpty() || ',' in value) {
            throw RangeNotSatisfiableException("Only one byte range is supported")
        }
        val match = RANGE.matchEntire(value)
            ?: throw RangeNotSatisfiableException("Malformed range")
        val first = match.groupValues[1]
        val second = match.groupValues[2]
        if (first.isEmpty() && second.isEmpty()) {
            throw RangeNotSatisfiableException("Malformed range")
        }

        val start: Long
        val end: Long
        if (first.isEmpty()) {
            val suffixLength = second.toLongOrNull()
                ?: throw RangeNotSatisfiableException("Invalid suffix")
            if (suffixLength <= 0) throw RangeNotSatisfiableException("Invalid suffix")
            start = (size - suffixLength).coerceAtLeast(0)
            end = (size - 1).coerceAtLeast(0)
        } else {
            start = first.toLongOrNull()
                ?: throw RangeNotSatisfiableException("Invalid range start")
            val requestedEnd = if (second.isEmpty()) {
                size - 1
            } else {
                second.toLongOrNull()
                    ?: throw RangeNotSatisfiableException("Invalid range end")
            }
            if (requestedEnd < start) {
                throw RangeNotSatisfiableException("Invalid range bounds")
            }
            end = requestedEnd.coerceAtMost(size - 1)
        }

        if (size == 0L || start >= size || end < start) {
            throw RangeNotSatisfiableException("Range starts after the resource")
        }
        return ByteRange(start, end)
    }

    private val RANGE = Regex("^(\\d*)-(\\d*)$")
}
