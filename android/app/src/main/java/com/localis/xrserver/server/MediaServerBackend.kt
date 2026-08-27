package com.localis.xrserver.server

import com.localis.xrserver.data.BuildMetadataEnvelope
import com.localis.xrserver.data.MediaPatch
import com.localis.xrserver.data.PlaybackProgress
import com.localis.xrserver.data.PublicMediaItem
import java.io.InputStream

/**
 * Platform storage boundary for the HTTP core.
 *
 * Implementations are called concurrently and must therefore provide their
 * own synchronization. No Android URI, document ID or filesystem path may be
 * exposed through [PublicMediaItem].
 */
interface MediaServerBackend {
    val serverName: String get() = "Localis"
    val build: BuildMetadataEnvelope? get() = null
    val mediaRootCount: Int
    val staticAssets: StaticAssetBackend get() = StaticAssetBackend.Empty

    fun listMedia(): List<PublicMediaItem>
    fun refreshMedia(): List<PublicMediaItem> = listMedia()
    fun findMedia(id: String): PublicMediaItem?
    fun updateMedia(id: String, patch: MediaPatch): PublicMediaItem?

    fun listProgress(): Map<String, PlaybackProgress>
    fun findProgress(id: String): PlaybackProgress?
    fun saveProgress(progress: PlaybackProgress): PlaybackProgress

    /**
     * Opens a stable, seekable representation of one media item.
     * [MediaContent.openAt] must return a new caller-owned stream positioned at
     * exactly the requested byte offset. The stream is always closed by the
     * HTTP core.
     */
    fun openMedia(id: String): MediaContent?
}

data class MediaContent(
    val item: PublicMediaItem,
    val length: Long,
    val contentType: String,
    val lastModifiedEpochMillis: Long,
    /** Opaque validator; the HTTP core adds quotes when needed. */
    val etag: String,
    val fileName: String = item.fileName,
    val openAt: (offset: Long) -> InputStream,
) {
    init {
        require(length >= 0) { "Media length must be known" }
        require(lastModifiedEpochMillis >= 0) { "Last-modified must be non-negative" }
    }
}

fun interface StaticAssetBackend {
    /** Path is normalized, relative, and never contains dot segments. */
    fun open(path: String): StaticAsset?

    data object Empty : StaticAssetBackend {
        override fun open(path: String): StaticAsset? = null
    }
}

data class StaticAsset(
    val length: Long,
    val contentType: String,
    val etag: String,
    val lastModifiedEpochMillis: Long? = null,
    val cacheControl: String = "public, max-age=31536000, immutable",
    val open: () -> InputStream,
) {
    init {
        require(length >= 0) { "Asset length must be known" }
        require(lastModifiedEpochMillis == null || lastModifiedEpochMillis >= 0) {
            "Last-modified must be non-negative"
        }
    }
}
