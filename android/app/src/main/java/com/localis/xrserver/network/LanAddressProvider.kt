package com.localis.xrserver.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections

object LanAddressProvider {
    fun currentIpv4Addresses(context: Context): List<Inet4Address> {
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val active = connectivity.activeNetwork
        val activeCapabilities = active?.let(connectivity::getNetworkCapabilities)
        val activeIsLan = activeCapabilities?.let { capabilities ->
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        } == true
        val activeAddresses = if (active != null && activeIsLan) {
            connectivity.getLinkProperties(active)?.linkAddresses.orEmpty()
                .map { it.address }
                .filterIsInstance<Inet4Address>()
                .filter(::isUsableLanAddress)
        } else {
            emptyList()
        }
        if (activeAddresses.isNotEmpty()) return activeAddresses.distinctBy { it.hostAddress }

        // A user-created hotspot is not necessarily the device's active
        // upstream network. Enumerating only RFC1918 interfaces is the narrow
        // fallback that still lets a joined headset reach the server.
        return runCatching {
            Collections.list(NetworkInterface.getNetworkInterfaces())
                .asSequence()
                .filter { it.isUp && !it.isLoopback && !isExcludedInterface(it.name) }
                .flatMap { Collections.list(it.inetAddresses).asSequence() }
                .filterIsInstance<Inet4Address>()
                .filter(::isUsableLanAddress)
                .distinctBy { it.hostAddress }
                .toList()
        }.getOrDefault(emptyList())
    }

    fun isStillAvailable(context: Context, address: Inet4Address): Boolean =
        currentIpv4Addresses(context).any { it.hostAddress == address.hostAddress }

    private fun isUsableLanAddress(address: Inet4Address): Boolean =
        !address.isLoopbackAddress && !address.isLinkLocalAddress && address.isSiteLocalAddress

    private fun isExcludedInterface(name: String): Boolean {
        val normalized = name.lowercase()
        return EXCLUDED_INTERFACE_PREFIXES.any(normalized::startsWith)
    }

    private val EXCLUDED_INTERFACE_PREFIXES = listOf("rmnet", "ccmni", "pdp", "tun", "tap", "ppp", "vpn")
}
