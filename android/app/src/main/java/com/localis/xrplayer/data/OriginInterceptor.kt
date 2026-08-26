package com.localis.xrplayer.data

import java.io.IOException
import okhttp3.Interceptor
import okhttp3.Response

class OriginInterceptor(
    private val serverOrigin: () -> okhttp3.HttpUrl?,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.method == "GET") return chain.proceed(request)

        val origin = serverOrigin() ?: throw IOException("服务器地址尚未配置")
        if (!ServerAddress.sameOrigin(origin, request.url)) {
            throw IOException("拒绝向跨域地址发送写请求")
        }
        return chain.proceed(
            request.newBuilder()
                .header("Origin", ServerAddress.origin(origin))
                .build(),
        )
    }
}
