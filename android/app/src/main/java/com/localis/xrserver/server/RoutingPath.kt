package com.localis.xrserver.server

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

data class RoutingPath(val segments: List<String>) {
    val relativeAssetPath: String get() = segments.joinToString("/")
}

object RoutingPaths {
    fun parse(target: String): RoutingPath {
        val rawPath = target.substringBefore('?')
        if (!rawPath.startsWith('/') || '\\' in rawPath || '\u0000' in rawPath) {
            throw HttpProblem(400, "invalid_request_target", "请求目标无效。")
        }
        if (rawPath == "/") return RoutingPath(emptyList())
        val rawSegments = rawPath.removePrefix("/").split('/')
        if (rawSegments.any { it.isEmpty() }) {
            throw HttpProblem(400, "invalid_path", "请求路径包含空片段。")
        }
        val decoded = rawSegments.map(::decodeSegment)
        if (decoded.any { it == "." || it == ".." || '/' in it || '\\' in it || '\u0000' in it }) {
            throw HttpProblem(400, "invalid_path", "请求路径无效。")
        }
        return RoutingPath(decoded)
    }

    private fun decodeSegment(value: String): String {
        val bytes = ByteArrayOutputStream(value.length)
        var index = 0
        while (index < value.length) {
            val character = value[index]
            if (character == '%') {
                if (index + 2 >= value.length) throw HttpProblem(400, "invalid_path_encoding", "路径编码无效。")
                val high = value[index + 1].digitToIntOrNull(16)
                val low = value[index + 2].digitToIntOrNull(16)
                if (high == null || low == null) throw HttpProblem(400, "invalid_path_encoding", "路径编码无效。")
                bytes.write(high * 16 + low)
                index += 3
            } else {
                if (character.code !in 0x21..0x7e) throw HttpProblem(400, "invalid_path_encoding", "路径编码无效。")
                bytes.write(character.code)
                index += 1
            }
        }
        return try {
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes.toByteArray()))
                .toString()
        } catch (_: Exception) {
            throw HttpProblem(400, "invalid_path_encoding", "路径编码无效。")
        }
    }
}
