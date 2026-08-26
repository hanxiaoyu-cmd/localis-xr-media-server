package com.localis.xrplayer.data

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object ServerAddress {
    fun normalize(rawValue: String): HttpUrl {
        val value = rawValue.trim()
        require(value.isNotEmpty()) { "请输入服务器地址" }
        val candidate = if (value.contains("://")) value else "http://$value"
        val url = candidate.toHttpUrlOrNull() ?: throw IllegalArgumentException("服务器地址格式无效")
        require(url.scheme == "http" || url.scheme == "https") { "仅支持 HTTP 或 HTTPS" }
        require(url.username.isEmpty() && url.password.isEmpty()) { "地址中不能包含用户名或密码" }
        require(url.encodedPath == "/" && url.query == null && url.fragment == null) {
            "请输入服务器根地址，不要附加路径、参数或片段"
        }
        require(url.scheme == "https" || isPrivateOrLoopback(url.host)) {
            "公网服务器必须使用 HTTPS；HTTP 仅允许私有局域网或本机地址"
        }
        return url.newBuilder().encodedPath("/").query(null).fragment(null).build()
    }

    fun origin(url: HttpUrl): String = buildString {
        append(url.scheme)
        append("://")
        if (':' in url.host) append('[').append(url.host).append(']') else append(url.host)
        val defaultPort = if (url.scheme == "https") 443 else 80
        if (url.port != defaultPort) append(':').append(url.port)
    }

    fun resolveSameOrigin(origin: HttpUrl, reference: String): HttpUrl {
        val resolved = origin.resolve(reference) ?: throw IllegalArgumentException("媒体地址无效")
        require(sameOrigin(origin, resolved)) { "服务器返回了跨域媒体地址，已拒绝发送会话" }
        return resolved
    }

    fun compatibilityManifest(origin: HttpUrl, mediaId: String): HttpUrl = origin.newBuilder()
        .addPathSegment("api")
        .addPathSegment("media")
        .addPathSegment(mediaId)
        .addPathSegment("hls")
        .addPathSegment("compat")
        .addPathSegment("index.m3u8")
        .build()

    fun sameOrigin(left: HttpUrl, right: HttpUrl): Boolean =
        left.scheme == right.scheme && left.host == right.host && left.port == right.port

    private fun isPrivateOrLoopback(host: String): Boolean {
        if (host.equals("localhost", ignoreCase = true) || host == "::1") return true
        if (host.contains(':')) {
            val first = host.substringBefore(':').toIntOrNull(16) ?: return false
            return first in 0xfc00..0xfdff
        }
        val octets = host.split('.').map { it.toIntOrNull() ?: return false }
        if (octets.size != 4 || octets.any { it !in 0..255 }) return false
        return octets[0] == 10 ||
            octets[0] == 127 ||
            (octets[0] == 172 && octets[1] in 16..31) ||
            (octets[0] == 192 && octets[1] == 168)
    }
}
