package com.localis.xrplayer.data

import kotlinx.serialization.Serializable

@Serializable
data class HealthResponse(
    val ok: Boolean = false,
    val service: String = "",
)

@Serializable
data class PairStatus(
    val paired: Boolean = false,
    val pairingRequired: Boolean = true,
)

@Serializable
data class PairCodeRequest(val code: String)

@Serializable
data class PairVerifyResponse(val paired: Boolean = false)

@Serializable
data class PublicMediaItem(
    val id: String,
    val kind: String,
    val title: String,
    val fileName: String = "",
    val extension: String = "",
    val size: Long = 0,
    val modifiedAt: String = "",
    val duration: Double = 0.0,
    val width: Int? = null,
    val height: Int? = null,
    val videoCodec: String? = null,
    val audioCodec: String? = null,
    val dynamicRange: String? = null,
    val projection: String = "flat",
    val stereo: String = "mono",
    val directPlay: Boolean = false,
    val streamUrl: String,
    val posterUrl: String? = null,
)

@Serializable
data class PlaybackProgress(
    val mediaId: String,
    val position: Double = 0.0,
    val duration: Double = 0.0,
    val updatedAt: String = "",
)

@Serializable
data class LibraryResponse(
    val items: List<PublicMediaItem> = emptyList(),
    val progress: Map<String, PlaybackProgress> = emptyMap(),
)

@Serializable
data class ProgressRequest(val position: Double, val duration: Double)

@Serializable
data class ProgressResponse(val progress: PlaybackProgress)

@Serializable
internal data class ApiErrorPayload(
    val error: String? = null,
    val message: String? = null,
    val retryAfter: Int? = null,
)

data class PlaybackSources(
    val direct: okhttp3.HttpUrl,
    val compatibility: okhttp3.HttpUrl,
)
