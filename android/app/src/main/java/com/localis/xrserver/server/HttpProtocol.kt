package com.localis.xrserver.server

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.FilterInputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.net.SocketTimeoutException
import kotlin.math.min

data class HttpLimits(
    val maxRequestLineBytes: Int = 8 * 1_024,
    val maxHeaderBytes: Int = 32 * 1_024,
    val maxHeaderCount: Int = 100,
    val maxBodyBytes: Int = 32 * 1_024,
) {
    init {
        require(maxRequestLineBytes in 256..65_536)
        require(maxHeaderBytes in 1_024..262_144)
        require(maxHeaderCount in 1..1_000)
        require(maxBodyBytes in 0..1_048_576)
    }
}

data class ParsedHttpRequest(
    val method: String,
    val target: String,
    val headers: Map<String, List<String>>,
    val body: ByteArray,
) {
    fun header(name: String): String? = headers[name.lowercase()]?.singleOrNull()
}

class HttpProblem(
    val status: Int,
    val code: String,
    override val message: String,
    val responseHeaders: Map<String, String> = emptyMap(),
) : Exception(message)

class HttpRequestParser(private val limits: HttpLimits) {
    fun parse(source: InputStream): ParsedHttpRequest? {
        val input = if (source is BufferedInputStream) source else BufferedInputStream(source)
        val requestLine = readCrlfLine(input, limits.maxRequestLineBytes, allowCleanEof = true) ?: return null
        val match = REQUEST_LINE.matchEntire(requestLine.value)
            ?: throw HttpProblem(400, "invalid_request_line", "请求行无效。")
        val method = match.groupValues[1]
        val target = match.groupValues[2]
        if (!target.startsWith('/') || '#' in target || target.any { it.code !in 0x21..0x7e }) {
            throw HttpProblem(400, "invalid_request_target", "请求目标无效。")
        }

        var headerBytes = 0
        var headerCount = 0
        val headers = linkedMapOf<String, MutableList<String>>()
        while (true) {
            val remaining = limits.maxHeaderBytes - headerBytes
            if (remaining <= 0) throw HttpProblem(431, "headers_too_large", "请求头过大。")
            val line = readCrlfLine(input, remaining, allowCleanEof = false)
                ?: throw HttpProblem(400, "incomplete_headers", "请求头不完整。")
            headerBytes += line.wireBytes
            if (line.value.isEmpty()) break
            headerCount += 1
            if (headerCount > limits.maxHeaderCount) {
                throw HttpProblem(431, "too_many_headers", "请求头数量过多。")
            }
            if (line.value.startsWith(' ') || line.value.startsWith('\t')) {
                throw HttpProblem(400, "folded_header_rejected", "不支持折叠请求头。")
            }
            val separator = line.value.indexOf(':')
            if (separator <= 0) throw HttpProblem(400, "invalid_header", "请求头无效。")
            val name = line.value.substring(0, separator)
            if (!HEADER_NAME.matches(name)) throw HttpProblem(400, "invalid_header_name", "请求头名称无效。")
            val value = line.value.substring(separator + 1).trim(' ', '\t')
            if (value.any { (it.code < 0x20 && it != '\t') || it.code == 0x7f }) {
                throw HttpProblem(400, "invalid_header_value", "请求头值无效。")
            }
            headers.getOrPut(name.lowercase()) { mutableListOf() }.add(value)
        }

        for (single in SINGLE_VALUE_HEADERS) {
            if ((headers[single]?.size ?: 0) > 1) {
                throw HttpProblem(400, "duplicate_header", "请求包含重复的 $single 头。")
            }
        }
        if (headers["host"].isNullOrEmpty()) throw HttpProblem(400, "host_required", "缺少 Host 请求头。")
        if (headers.containsKey("expect")) {
            throw HttpProblem(417, "expectation_failed", "不支持 Expect 请求。")
        }

        val transferEncoding = headers["transfer-encoding"]?.singleOrNull()
        if (transferEncoding != null && headers.containsKey("content-length")) {
            throw HttpProblem(400, "ambiguous_body_length", "请求不能同时包含 Transfer-Encoding 和 Content-Length。")
        }
        val body = if (transferEncoding != null) {
            if (!transferEncoding.equals("chunked", ignoreCase = true)) {
                throw HttpProblem(501, "transfer_encoding_unsupported", "仅支持 chunked Transfer-Encoding。")
            }
            readChunkedBody(input)
        } else {
            val contentLength = headers["content-length"]?.single()?.let { value ->
                value.takeIf(DECIMAL_CONTENT_LENGTH::matches)?.toLongOrNull()
                    ?: throw HttpProblem(400, "invalid_content_length", "Content-Length 无效。")
            } ?: 0L
            if (contentLength > limits.maxBodyBytes) {
                throw HttpProblem(413, "body_too_large", "请求体过大。")
            }
            ByteArray(contentLength.toInt()).also { target -> readExactly(input, target, 0, target.size) }
        }
        return ParsedHttpRequest(method, target, headers.mapValues { it.value.toList() }, body)
    }

    private fun readChunkedBody(input: InputStream): ByteArray {
        val result = ByteArrayOutputStream(min(limits.maxBodyBytes, 4 * 1_024))
        var chunkCount = 0
        while (true) {
            chunkCount += 1
            if (chunkCount > MAX_CHUNK_COUNT) {
                throw HttpProblem(413, "too_many_chunks", "请求体分块数量过多。")
            }
            val sizeLine = readCrlfLine(input, MAX_CHUNK_LINE_BYTES, allowCleanEof = false)
                ?: throw HttpProblem(400, "incomplete_chunk", "请求体分块不完整。")
            if (!CHUNK_SIZE.matches(sizeLine.value)) {
                throw HttpProblem(400, "invalid_chunk_size", "请求体分块大小无效。")
            }
            val chunkSize = sizeLine.value.toLongOrNull(16)
                ?: throw HttpProblem(400, "invalid_chunk_size", "请求体分块大小无效。")
            if (chunkSize == 0L) {
                val trailerEnd = readCrlfLine(input, MAX_CHUNK_LINE_BYTES, allowCleanEof = false)
                    ?: throw HttpProblem(400, "incomplete_chunk", "请求体分块不完整。")
                if (trailerEnd.value.isNotEmpty()) {
                    throw HttpProblem(400, "trailers_unsupported", "不支持 chunked trailer。")
                }
                return result.toByteArray()
            }
            if (chunkSize > (limits.maxBodyBytes - result.size()).toLong()) {
                throw HttpProblem(413, "body_too_large", "请求体过大。")
            }
            val chunk = ByteArray(chunkSize.toInt())
            readExactly(input, chunk, 0, chunk.size)
            result.write(chunk)
            val terminator = ByteArray(2)
            readExactly(input, terminator, 0, terminator.size)
            if (terminator[0] != '\r'.code.toByte() || terminator[1] != '\n'.code.toByte()) {
                throw HttpProblem(400, "invalid_chunk_ending", "请求体分块结尾无效。")
            }
        }
    }

    private fun readExactly(input: InputStream, target: ByteArray, offset: Int, length: Int) {
        var current = offset
        val end = offset + length
        while (current < end) {
            val read = input.read(target, current, end - current)
            if (read < 0) throw HttpProblem(400, "incomplete_body", "请求体不完整。")
            current += read
        }
    }

    private data class WireLine(val value: String, val wireBytes: Int)

    private fun readCrlfLine(input: InputStream, maximumBytes: Int, allowCleanEof: Boolean): WireLine? {
        val bytes = ByteArrayOutputStream(min(maximumBytes, 1_024))
        var wireBytes = 0
        var previousWasCarriageReturn = false
        while (true) {
            val next = input.read()
            if (next < 0) {
                if (wireBytes == 0 && allowCleanEof) return null
                throw HttpProblem(400, "incomplete_line", "HTTP 行不完整。")
            }
            wireBytes += 1
            if (wireBytes > maximumBytes) {
                throw HttpProblem(
                    if (allowCleanEof) 414 else 431,
                    if (allowCleanEof) "request_line_too_large" else "headers_too_large",
                    if (allowCleanEof) "请求行过长。" else "请求头过大。",
                )
            }
            if (next == '\n'.code) {
                if (!previousWasCarriageReturn) throw HttpProblem(400, "invalid_line_ending", "HTTP 行必须使用 CRLF。")
                val raw = bytes.toByteArray()
                return WireLine(String(raw, 0, raw.size - 1, StandardCharsets.ISO_8859_1), wireBytes)
            }
            bytes.write(next)
            previousWasCarriageReturn = next == '\r'.code
        }
    }

    companion object {
        private val REQUEST_LINE = Regex("^([A-Z]+) ([^ ]+) HTTP/1\\.1$")
        private val HEADER_NAME = Regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
        private val DECIMAL_CONTENT_LENGTH = Regex("^[0-9]+$")
        private val CHUNK_SIZE = Regex("^[0-9A-Fa-f]+$")
        private const val MAX_CHUNK_LINE_BYTES = 128
        private const val MAX_CHUNK_COUNT = 1_024
        private val SINGLE_VALUE_HEADERS = setOf(
            "host",
            "content-length",
            "transfer-encoding",
            "origin",
            "range",
            "if-range",
        )
    }
}

class DeadlineInputStream(
    source: InputStream,
    timeoutMillis: Int,
    private val nanoTime: () -> Long = System::nanoTime,
    private val beforeBlockingRead: (remainingMillis: Int) -> Unit = {},
) : FilterInputStream(source) {
    private val deadlineNanos = nanoTime() + timeoutMillis * 1_000_000L

    override fun read(): Int {
        beforeBlockingRead(checkDeadline())
        return super.read()
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        beforeBlockingRead(checkDeadline())
        return super.read(buffer, offset, length)
    }

    private fun checkDeadline(): Int {
        val remainingNanos = deadlineNanos - nanoTime()
        if (remainingNanos <= 0) {
            throw SocketTimeoutException("HTTP request deadline exceeded")
        }
        return ((remainingNanos + 999_999L) / 1_000_000L)
            .coerceIn(1L, Int.MAX_VALUE.toLong())
            .toInt()
    }
}

class HttpResponseWriter(
    target: OutputStream,
    private val headOnly: Boolean,
    private val onWriteStart: () -> Unit = {},
    private val onWriteProgress: () -> Unit = {},
) {
    private val output = if (target is BufferedOutputStream) target else BufferedOutputStream(target)

    var committed: Boolean = false
        private set

    fun sendBytes(
        status: Int,
        contentType: String,
        body: ByteArray,
        headers: Map<String, String> = emptyMap(),
        contentLength: Long = body.size.toLong(),
    ) {
        writeHeaders(status, headers + mapOf("Content-Type" to contentType), contentLength)
        if (!headOnly && body.isNotEmpty()) {
            output.write(body)
            onWriteProgress()
        }
        output.flush()
        onWriteProgress()
    }

    fun sendStream(
        status: Int,
        contentType: String,
        contentLength: Long,
        headers: Map<String, String>,
        open: () -> InputStream,
    ) {
        onWriteStart()
        if (headOnly) {
            writeHeaders(status, headers + mapOf("Content-Type" to contentType), contentLength)
            output.flush()
            onWriteProgress()
            return
        }
        open().use { input ->
            writeHeaders(status, headers + mapOf("Content-Type" to contentType), contentLength)
            val buffer = ByteArray(DEFAULT_COPY_BUFFER_SIZE)
            var remaining = contentLength
            while (remaining > 0) {
                val read = input.read(buffer, 0, min(buffer.size.toLong(), remaining).toInt())
                if (read < 0) throw EOFException("Backend media stream ended early")
                output.write(buffer, 0, read)
                onWriteProgress()
                remaining -= read
            }
            output.flush()
            onWriteProgress()
        }
    }

    private fun writeHeaders(status: Int, custom: Map<String, String>, contentLength: Long) {
        check(!committed) { "Response already committed" }
        require(contentLength >= 0)
        onWriteStart()
        val headers = linkedMapOf(
            "Connection" to "close",
            "Content-Length" to contentLength.toString(),
            "Referrer-Policy" to "no-referrer",
            "X-Content-Type-Options" to "nosniff",
            "X-Frame-Options" to "DENY",
            "Permissions-Policy" to "camera=(), microphone=(), geolocation=()",
        )
        headers.putAll(custom)
        headers["Connection"] = "close"
        headers["Content-Length"] = contentLength.toString()
        headers.forEach { (name, value) ->
            require(HEADER_NAME.matches(name) && value.none { it == '\r' || it == '\n' }) { "Unsafe response header" }
        }
        committed = true
        output.write("HTTP/1.1 $status ${reason(status)}\r\n".toByteArray(StandardCharsets.ISO_8859_1))
        onWriteProgress()
        headers.forEach { (name, value) ->
            output.write("$name: $value\r\n".toByteArray(StandardCharsets.ISO_8859_1))
            onWriteProgress()
        }
        output.write("\r\n".toByteArray(StandardCharsets.ISO_8859_1))
        onWriteProgress()
    }

    private fun reason(status: Int): String = when (status) {
        200 -> "OK"
        201 -> "Created"
        204 -> "No Content"
        206 -> "Partial Content"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        408 -> "Request Timeout"
        413 -> "Content Too Large"
        414 -> "URI Too Long"
        415 -> "Unsupported Media Type"
        416 -> "Range Not Satisfiable"
        417 -> "Expectation Failed"
        421 -> "Misdirected Request"
        429 -> "Too Many Requests"
        431 -> "Request Header Fields Too Large"
        500 -> "Internal Server Error"
        501 -> "Not Implemented"
        503 -> "Service Unavailable"
        else -> "Response"
    }

    companion object {
        private const val DEFAULT_COPY_BUFFER_SIZE = 64 * 1_024
        private val HEADER_NAME = Regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
    }
}
