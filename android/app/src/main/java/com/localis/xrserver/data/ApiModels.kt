package com.localis.xrserver.data

import kotlinx.serialization.Serializable

@Serializable
data class ApiError(
    val error: String,
    val message: String? = null,
    val retryAfter: Int? = null,
    val attemptsRemaining: Int? = null,
)

@Serializable
data class BuildMetadata(
    val schemaVersion: Int = 1,
    val buildId: String,
    val version: String,
    val commitSha: String,
    val commitShortSha: String,
    val buildTime: String,
    val dirty: Boolean,
    val channel: String,
)

@Serializable
data class BuildMetadataEnvelope(
    val available: Boolean = true,
    val status: String = "available",
    val metadata: BuildMetadata,
)

@Serializable
data class AiCapability(
    val available: Boolean = false,
    val backend: String = "none",
    val reason: String = "Android Beta 仅支持原片直放。",
)

@Serializable
data class HealthResponse(
    val ok: Boolean = true,
    val service: String = "localis",
    val build: BuildMetadataEnvelope? = null,
    val mediaCount: Int,
    val encoder: String = "android-direct",
    val aiSuperResolution: AiCapability = AiCapability(),
)

@Serializable
data class PairStatusResponse(
    val paired: Boolean,
    val pairingRequired: Boolean = true,
    val pairingCode: String? = null,
)

@Serializable
data class PairVerifyRequest(val code: String = "")

@Serializable
data class PairVerifyResponse(val paired: Boolean = true)

@Serializable
data class ServerInfoResponse(
    val name: String,
    val build: BuildMetadataEnvelope? = null,
    val secure: Boolean,
    val secureContextRequiredForWebXR: Boolean = true,
    val host: String,
    val port: Int,
    val encoder: String = "android-direct",
    val aiSuperResolution: AiCapability = AiCapability(),
    val mediaCount: Int,
    val libraryCount: Int,
    val pairingCode: String? = null,
    val canPickLocalFolder: Boolean = false,
    val nativeFolderPicker: Boolean = false,
    val canManageCloud: Boolean = false,
    val cloudSourceCount: Int = 0,
    val lanUrls: List<String> = emptyList(),
    val publicUrl: String? = null,
)

@Serializable
data class MediaTrack(
    val index: Int,
    val codec: String,
    val language: String? = null,
    val title: String? = null,
    val channels: Int? = null,
)

@Serializable
data class SubtitleTrack(
    val index: Int,
    val codec: String,
    val language: String? = null,
    val title: String? = null,
    val channels: Int? = null,
    val source: String,
)

/**
 * Browser-visible media metadata. Android content URIs, document IDs and local
 * paths deliberately do not belong in this model.
 */
@Serializable
data class PublicMediaItem(
    val id: String,
    val kind: String,
    val title: String,
    val fileName: String,
    val relativePath: String,
    val extension: String,
    val size: Long,
    val modifiedAt: String,
    val duration: Double,
    val width: Int? = null,
    val height: Int? = null,
    val frameRate: Double? = null,
    val videoCodec: String? = null,
    val videoProfile: String? = null,
    val videoLevel: Int? = null,
    val pixelFormat: String? = null,
    val bitDepth: Int? = null,
    val dynamicRange: String? = null,
    val colorPrimaries: String? = null,
    val colorTransfer: String? = null,
    val colorSpace: String? = null,
    val colorRange: String? = null,
    val sampleAspectRatio: String? = null,
    val audioCodec: String? = null,
    val container: String? = null,
    val projection: String = "flat",
    val stereo: String = "mono",
    val eyeOrder: String = "lr",
    val yawOffset: Double = 0.0,
    val audioTracks: List<MediaTrack> = emptyList(),
    val subtitleTracks: List<SubtitleTrack> = emptyList(),
    val directPlay: Boolean = true,
    val compatibilityMode: String = "direct",
    val compatibilityReason: String = "Android Beta 仅支持浏览器原片直放。",
    val sourceType: String = "local",
    val streamUrl: String,
    val posterUrl: String? = null,
    val hlsUrl: String? = null,
)

@Serializable
data class PlaybackProgress(
    val mediaId: String,
    val position: Double,
    val duration: Double,
    val updatedAt: String,
)

@Serializable
data class LibraryResponse(
    val items: List<PublicMediaItem>,
    val progress: Map<String, PlaybackProgress>,
)

@Serializable
data class LibraryRefreshResponse(val items: List<PublicMediaItem>)

@Serializable
data class MediaPatch(
    val projection: String? = null,
    val stereo: String? = null,
    val eyeOrder: String? = null,
    val yawOffset: Double? = null,
    val title: String? = null,
)

@Serializable
data class MediaUpdateResponse(val item: PublicMediaItem)

@Serializable
data class ProgressRequest(
    val position: Double = 0.0,
    val duration: Double = 0.0,
)

@Serializable
data class ProgressResponse(val progress: PlaybackProgress)

@Serializable
data class SuperResolutionPlan(
    val level: String = "off",
    val label: String = "关闭",
    val scale: Double = 1.0,
    val maxLongEdge: Int = 3840,
    val maxPixels: Int = 12_000_000,
    val sharpness: Double = 0.0,
    val interpolation: String = "spline16",
    val nvencCq: Int = 21,
    val maxRate: String = "24M",
    val available: Boolean = false,
    val enabled: Boolean = false,
    val activeMode: String = "off",
    val reason: String = "Android Beta 不提供服务器端增强或转码。",
)

@Serializable
data class DirectPlaybackStatus(
    val state: String = "idle",
    val mode: String = "direct",
    val forcedCompatibility: Boolean = false,
    val encoder: String = "copy",
    val progressSeconds: Double = 0.0,
    val durationSeconds: Double,
    val progressPercent: Double = 0.0,
    val speed: Double = 0.0,
    val generationState: String = "waiting",
    val strategy: String = "eager",
    val seekable: Boolean = true,
    val superResolution: String = "off",
    val plan: SuperResolutionPlan = SuperResolutionPlan(),
)

@Serializable
data class MediaDetailResponse(
    val item: PublicMediaItem,
    val progress: PlaybackProgress? = null,
    val transcode: DirectPlaybackStatus = DirectPlaybackStatus(durationSeconds = item.duration),
    val build: BuildMetadataEnvelope? = null,
)
