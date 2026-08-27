package com.localis.xrserver.server

import java.net.URI

data class HttpAuthority(val host: String, val port: Int?) {
    fun render(): String = if (':' in host) {
        "[$host]${port?.let { ":$it" }.orEmpty()}"
    } else {
        "$host${port?.let { ":$it" }.orEmpty()}"
    }
}

data class HttpOrigin(val scheme: String, val authority: HttpAuthority) {
    val effectivePort: Int get() = authority.port ?: RequestSecurity.defaultPort(scheme)
    fun render(): String = "$scheme://${authority.render()}"
}

object RequestSecurity {
    fun parseAuthority(value: String): HttpAuthority? {
        if (value.isBlank() || value != value.trim() || value.any { it <= ' ' || it == '/' || it == '\\' || it == '@' }) {
            return null
        }
        if (value.startsWith('[')) {
            val closing = value.indexOf(']')
            if (closing <= 1) return null
            val host = value.substring(1, closing).lowercase()
            if (':' !in host || host.any { !(it.isDigit() || it.lowercaseChar() in 'a'..'f' || it == ':' || it == '.') }) {
                return null
            }
            val remainder = value.substring(closing + 1)
            val port = when {
                remainder.isEmpty() -> null
                remainder.startsWith(':') -> parsePort(remainder.substring(1))
                else -> return null
            }
            if (remainder.isNotEmpty() && port == null) return null
            return HttpAuthority(host, port)
        }

        if (value.count { it == ':' } > 1) return null
        val separator = value.lastIndexOf(':')
        val hostPart = if (separator >= 0) value.substring(0, separator) else value
        val port = if (separator >= 0) parsePort(value.substring(separator + 1)) else null
        if (separator >= 0 && port == null) return null
        val host = hostPart.lowercase()
        if (!validDnsOrIpv4Host(host)) return null
        return HttpAuthority(host, port)
    }

    fun isAllowedHost(hostHeader: String, allowedHosts: Set<String>): Boolean {
        val authority = parseAuthority(hostHeader) ?: return false
        return allowedHosts.any { allowed ->
            val normalized = parseAuthority(allowed)?.host ?: allowed.trim().removePrefix("[").removeSuffix("]").lowercase()
            authority.host == normalized
        }
    }

    fun isAllowedLocalAuthority(
        hostHeader: String,
        allowedHosts: Set<String>,
        scheme: String,
        listenerPort: Int,
    ): Boolean {
        val authority = parseAuthority(hostHeader) ?: return false
        val hostAllowed = allowedHosts.any { allowed ->
            val normalized = parseAuthority(allowed)?.host
                ?: allowed.trim().removePrefix("[").removeSuffix("]").lowercase()
            authority.host == normalized
        }
        if (!hostAllowed) return false
        return (authority.port ?: defaultPort(scheme)) == listenerPort
    }

    fun authorityMatchesConfiguredOrigin(hostHeader: String, configuredOrigin: String): Boolean {
        val authority = parseAuthority(hostHeader) ?: return false
        val origin = parseOrigin(configuredOrigin) ?: return false
        if (authority.host != origin.authority.host) return false
        return (authority.port ?: defaultPort(origin.scheme)) == origin.effectivePort
    }

    fun parseOrigin(value: String): HttpOrigin? {
        if (value.isBlank() || value != value.trim()) return null
        val uri = try {
            URI(value)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (uri.rawAuthority == null || uri.userInfo != null) return null
        if (!uri.rawPath.isNullOrEmpty() || uri.rawQuery != null || uri.rawFragment != null) return null
        val authority = parseAuthority(uri.rawAuthority) ?: return null
        return HttpOrigin(scheme, authority)
    }

    fun originMatches(scheme: String, hostHeader: String, originHeader: String): Boolean {
        val expectedAuthority = parseAuthority(hostHeader) ?: return false
        val origin = parseOrigin(originHeader) ?: return false
        if (!origin.scheme.equals(scheme, ignoreCase = true)) return false
        val actualAuthority = origin.authority
        val expectedPort = expectedAuthority.port ?: defaultPort(scheme)
        val actualPort = origin.effectivePort
        return expectedAuthority.host == actualAuthority.host && expectedPort == actualPort
    }

    fun canonicalOrigin(scheme: String, hostHeader: String): String? {
        val authority = parseAuthority(hostHeader) ?: return null
        return "${scheme.lowercase()}://${authority.render()}"
    }

    fun defaultPort(scheme: String): Int = when (scheme.lowercase()) {
        "http" -> 80
        "https" -> 443
        else -> -1
    }

    private fun parsePort(value: String): Int? = value.toIntOrNull()?.takeIf { it in 1..65_535 }

    private fun validDnsOrIpv4Host(value: String): Boolean {
        if (value.isEmpty() || value.length > 253 || value.startsWith('.') || value.endsWith('.')) return false
        if (value.any { !(it.isLetterOrDigit() || it == '.' || it == '-') }) return false
        return value.split('.').all { label ->
            label.isNotEmpty() && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-')
        }
    }
}
