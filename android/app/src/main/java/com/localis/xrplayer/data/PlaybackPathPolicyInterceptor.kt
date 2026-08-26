package com.localis.xrplayer.data

import java.io.IOException
import okhttp3.Interceptor
import okhttp3.Response

/** Restricts the shared API/media client to this server and the Android beta route surface. */
class PlaybackPathPolicyInterceptor(
    private val serverOrigin: () -> okhttp3.HttpUrl?,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val origin = serverOrigin() ?: throw IOException("服务器地址尚未配置")
        if (!ServerAddress.sameOrigin(origin, request.url)) throw IOException("已阻止跨来源媒体请求")
        if (!isAllowed(request.method, request.url.pathSegments)) throw IOException("已阻止非基础播放接口")
        return chain.proceed(request)
    }

    private fun isAllowed(method: String, segments: List<String>): Boolean = when {
        method == "GET" && segments == listOf("api", "health") -> true
        method == "GET" && segments == listOf("api", "pair", "status") -> true
        method == "POST" && segments == listOf("api", "pair", "verify") -> true
        method == "GET" && segments == listOf("api", "library") -> true
        method == "PUT" && segments.size == 3 && segments[0] == "api" && segments[1] == "progress" -> true
        method in setOf("GET", "HEAD") &&
            segments.size == 4 &&
            segments[0] == "api" && segments[1] == "media" && segments[3] == "stream" -> true
        method == "GET" &&
            segments.size == 6 &&
            segments[0] == "api" && segments[1] == "media" &&
            segments[3] == "hls" && segments[4] == "compat" &&
            HLS_ASSET.matches(segments[5]) -> true
        else -> false
    }

    private companion object {
        val HLS_ASSET = Regex("index\\.m3u8|init\\.mp4|seg_\\d{6}\\.(?:m4s|ts)")
    }
}
