package com.localis.xrplayer.data

import java.io.IOException
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class LocalisApi(
    private val client: OkHttpClient,
    private val originStore: ServerOriginStore,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    fun configuredOrigin(): HttpUrl? = originStore.get()

    fun configure(rawAddress: String): HttpUrl = ServerAddress.normalize(rawAddress).also(originStore::set)

    suspend fun health(): HealthResponse = get("api/health", MAX_SMALL_API_BODY_BYTES)

    suspend fun pairStatus(): PairStatus = get("api/pair/status", MAX_SMALL_API_BODY_BYTES)

    suspend fun verifyPairing(code: String): PairVerifyResponse = post(
        "api/pair/verify",
        json.encodeToString(PairCodeRequest(code.trim())),
        MAX_SMALL_API_BODY_BYTES,
    )

    suspend fun library(): LibraryResponse = get("api/library", MAX_LIBRARY_BODY_BYTES)

    suspend fun saveProgress(mediaId: String, positionSeconds: Double, durationSeconds: Double): PlaybackProgress {
        val response: ProgressResponse = put(
            progressUrl(mediaId),
            json.encodeToString(
                ProgressRequest(
                    position = positionSeconds.coerceAtLeast(0.0),
                    duration = durationSeconds.coerceAtLeast(0.0),
                ),
            ),
            MAX_SMALL_API_BODY_BYTES,
        )
        return response.progress
    }

    fun playbackSources(item: PublicMediaItem): PlaybackSources {
        val origin = requireOrigin()
        val direct = ServerAddress.resolveSameOrigin(origin, item.streamUrl)
        require(direct.pathSegments == listOf("api", "media", item.id, "stream")) {
            "服务器返回了非标准原片地址"
        }
        return PlaybackSources(
            direct = direct,
            compatibility = ServerAddress.compatibilityManifest(origin, item.id),
        )
    }

    suspend fun awaitCompatibilityManifest(mediaId: String, maxAttempts: Int = Int.MAX_VALUE): HttpUrl {
        val manifest = ServerAddress.compatibilityManifest(requireOrigin(), mediaId)
        repeat(maxAttempts.coerceAtLeast(1)) { attempt ->
            val request = Request.Builder().url(manifest).get().build()
            val waitSeconds = withContext(Dispatchers.IO) {
                client.newCall(request).execute().use { response ->
                    if (response.code == 200) {
                        val contentType = response.header("Content-Type").orEmpty().lowercase()
                        val body = readBodyLimited(response.body, MAX_MANIFEST_BYTES)
                        if (("mpegurl" in contentType || "m3u8" in contentType) && body.trimStart().startsWith("#EXTM3U")) {
                            return@withContext 0L
                        }
                        throw IOException("服务器未返回有效的兼容流清单")
                    }
                    if (response.code !in setOf(202, 429, 503)) {
                        throw apiException(response.code, readBodyLimited(response.body, MAX_ERROR_BODY_BYTES))
                    }
                    response.header("Retry-After")?.toLongOrNull()?.coerceIn(1, 5) ?: 1L
                }
            }
            if (waitSeconds == 0L) return manifest
            if (attempt + 1 < maxAttempts) delay(waitSeconds * 1_000)
        }
        throw IOException("兼容流准备超时，请稍后重试")
    }

    private suspend inline fun <reified T> get(path: String, maxSuccessBytes: Int): T = execute(
        Request.Builder().url(url(path)).get().build(),
        maxSuccessBytes,
    )

    private suspend inline fun <reified T> post(path: String, body: String, maxSuccessBytes: Int): T = execute(
        Request.Builder().url(url(path)).post(body.toRequestBody(JSON_MEDIA_TYPE)).build(),
        maxSuccessBytes,
    )

    private suspend inline fun <reified T> put(url: HttpUrl, body: String, maxSuccessBytes: Int): T = execute(
        Request.Builder().url(url).put(body.toRequestBody(JSON_MEDIA_TYPE)).build(),
        maxSuccessBytes,
    )

    private suspend inline fun <reified T> execute(request: Request, maxSuccessBytes: Int): T =
        withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val body = readBodyLimited(
                response.body,
                if (response.isSuccessful) maxSuccessBytes else MAX_ERROR_BODY_BYTES,
            )
            if (!response.isSuccessful) throw apiException(response.code, body)
            json.decodeFromString<T>(body)
        }
    }

    private fun readBodyLimited(body: okhttp3.ResponseBody?, maxBytes: Int): String {
        if (body == null) return ""
        val declaredLength = body.contentLength()
        if (declaredLength > maxBytes) throw IOException("服务器响应过大")
        val source = body.source()
        val buffer = okio.Buffer()
        val limit = maxBytes.toLong() + 1
        var total = 0L
        while (total < limit) {
            val read = source.read(buffer, minOf(READ_CHUNK_BYTES, limit - total))
            if (read < 0L) break
            total += read
        }
        if (total > maxBytes) throw IOException("服务器响应过大")
        return buffer.readString(Charsets.UTF_8)
    }

    private fun apiException(status: Int, body: String): LocalisApiException {
        val payload = runCatching { json.decodeFromString<ApiErrorPayload>(body) }.getOrNull()
        return LocalisApiException(
            status = status,
            code = payload?.error,
            detail = payload?.message,
            retryAfterSeconds = payload?.retryAfter,
        )
    }

    private fun url(path: String): HttpUrl = requireOrigin().resolve(path)
        ?: throw IllegalArgumentException("API 地址无效")

    private fun requireOrigin(): HttpUrl = originStore.get()
        ?: throw IllegalStateException("服务器地址尚未配置")

    private fun progressUrl(mediaId: String): HttpUrl = requireOrigin().newBuilder()
        .addPathSegment("api")
        .addPathSegment("progress")
        .addPathSegment(mediaId)
        .build()

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private const val MAX_MANIFEST_BYTES = 512 * 1024
        private const val MAX_ERROR_BODY_BYTES = 64 * 1024
        private const val MAX_SMALL_API_BODY_BYTES = 64 * 1024
        private const val MAX_LIBRARY_BODY_BYTES = 16 * 1024 * 1024
        private const val READ_CHUNK_BYTES = 8 * 1024L
    }
}

class LocalisApiException(
    val status: Int,
    val code: String?,
    val detail: String?,
    val retryAfterSeconds: Int?,
) : IOException(detail ?: code ?: "服务器返回 HTTP $status")
