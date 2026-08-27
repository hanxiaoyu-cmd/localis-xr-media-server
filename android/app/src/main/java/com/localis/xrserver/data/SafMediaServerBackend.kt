package com.localis.xrserver.data

import android.content.Context
import android.content.res.AssetManager
import androidx.core.content.edit
import com.localis.xrserver.BuildConfig
import com.localis.xrserver.server.MediaContent
import com.localis.xrserver.server.MediaServerBackend
import com.localis.xrserver.server.StaticAsset
import com.localis.xrserver.server.StaticAssetBackend
import java.io.InputStream
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class SafMediaServerBackend(
    context: Context,
    private val repository: SafMediaRepository,
) : MediaServerBackend {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val progress = ConcurrentHashMap<String, PlaybackProgress>()
    private val patches = ConcurrentHashMap<String, MediaPatch>()

    override val serverName: String = "Localis Android"
    override val build: BuildMetadataEnvelope = BuildMetadataEnvelope(
        metadata = BuildMetadata(
            buildId = "android-${BuildConfig.VERSION_NAME}-${BuildConfig.LOCALIS_COMMIT_SHORT_SHA}",
            version = BuildConfig.VERSION_NAME,
            commitSha = BuildConfig.LOCALIS_COMMIT_SHA,
            commitShortSha = BuildConfig.LOCALIS_COMMIT_SHORT_SHA,
            buildTime = BuildConfig.LOCALIS_BUILD_TIME,
            dirty = BuildConfig.LOCALIS_BUILD_DIRTY,
            channel = BuildConfig.LOCALIS_BUILD_CHANNEL,
        ),
    )
    override val staticAssets: StaticAssetBackend = AndroidAssetBackend(context.applicationContext)

    init {
        loadStoredProgress()
        loadStoredPatches()
    }

    override val mediaRootCount: Int
        get() = if (repository.selectedTreeUri() == null) 0 else 1

    override fun listMedia(): List<PublicMediaItem> = repository.state.value.media.map { record ->
        applyPatch(record.item, patches[record.item.id])
    }

    override fun refreshMedia(): List<PublicMediaItem> = runBlocking {
        repository.refresh()
        pruneState()
        listMedia()
    }

    override fun findMedia(id: String): PublicMediaItem? = repository.findMedia(id)?.item?.let { item ->
        applyPatch(item, patches[id])
    }

    override fun updateMedia(id: String, patch: MediaPatch): PublicMediaItem? {
        val original = repository.findMedia(id)?.item ?: return null
        val normalized = normalizePatch(patch) ?: return null
        patches.compute(id) { _, previous -> merge(previous, normalized) }
        persistPatches()
        return applyPatch(original, patches[id])
    }

    override fun listProgress(): Map<String, PlaybackProgress> = progress.toMap()

    override fun findProgress(id: String): PlaybackProgress? = progress[id]

    override fun saveProgress(progress: PlaybackProgress): PlaybackProgress {
        val safe = progress.copy(
            position = progress.position.takeIf(Double::isFinite)?.coerceAtLeast(0.0) ?: 0.0,
            duration = progress.duration.takeIf(Double::isFinite)?.coerceAtLeast(0.0) ?: 0.0,
            updatedAt = progress.updatedAt.takeIf(String::isNotBlank) ?: Instant.now().toString(),
        )
        this.progress[safe.mediaId] = safe
        persistProgress()
        return safe
    }

    override fun openMedia(id: String): MediaContent? {
        val record = repository.findMedia(id) ?: return null
        val item = applyPatch(record.item, patches[id])
        return MediaContent(
            item = item,
            length = record.length,
            contentType = record.contentType,
            lastModifiedEpochMillis = record.lastModifiedEpochMillis,
            etag = record.etag,
            fileName = record.item.fileName,
            openAt = { offset -> repository.openAt(record, offset) },
        )
    }

    private fun pruneState() {
        val ids = repository.state.value.media.asSequence().map { it.item.id }.toSet()
        patches.keys.removeAll { it !in ids }
        progress.keys.removeAll { it !in ids }
        persistPatches()
        persistProgress()
    }

    private fun normalizePatch(patch: MediaPatch): MediaPatch? {
        val projection = patch.projection?.lowercase()?.takeIf {
            it in setOf("flat", "equirect180", "equirect360")
        }
            ?: if (patch.projection == null) null else return null
        val stereo = patch.stereo?.lowercase()?.takeIf { it in setOf("mono", "sbs", "tb") }
            ?: if (patch.stereo == null) null else return null
        val eyeOrder = patch.eyeOrder?.lowercase()?.takeIf { it in setOf("lr", "rl") }
            ?: if (patch.eyeOrder == null) null else return null
        val yawOffset = patch.yawOffset?.takeIf {
            it.isFinite() && it in -(Math.PI * 2)..(Math.PI * 2)
        }
            ?: if (patch.yawOffset == null) null else return null
        val title = patch.title?.trim()?.takeIf { it.isNotEmpty() && it.length <= 200 }
            ?: if (patch.title == null) null else return null
        return MediaPatch(projection, stereo, eyeOrder, yawOffset, title)
    }

    private fun merge(previous: MediaPatch?, current: MediaPatch): MediaPatch = MediaPatch(
        projection = current.projection ?: previous?.projection,
        stereo = current.stereo ?: previous?.stereo,
        eyeOrder = current.eyeOrder ?: previous?.eyeOrder,
        yawOffset = current.yawOffset ?: previous?.yawOffset,
        title = current.title ?: previous?.title,
    )

    private fun applyPatch(item: PublicMediaItem, patch: MediaPatch?): PublicMediaItem = if (patch == null) {
        item
    } else {
        item.copy(
            projection = patch.projection ?: item.projection,
            stereo = patch.stereo ?: item.stereo,
            eyeOrder = patch.eyeOrder ?: item.eyeOrder,
            yawOffset = patch.yawOffset ?: item.yawOffset,
            title = patch.title ?: item.title,
        )
    }

    private fun loadStoredProgress() {
        preferences.getString(KEY_PROGRESS, null)?.let { encoded ->
            runCatching { json.decodeFromString<Map<String, PlaybackProgress>>(encoded) }
                .getOrNull()
                ?.let(progress::putAll)
        }
    }

    private fun loadStoredPatches() {
        preferences.getString(KEY_PATCHES, null)?.let { encoded ->
            runCatching { json.decodeFromString<Map<String, MediaPatch>>(encoded) }
                .getOrNull()
                ?.let(patches::putAll)
        }
    }

    @Synchronized
    private fun persistProgress() {
        preferences.edit { putString(KEY_PROGRESS, json.encodeToString(progress.toMap())) }
    }

    @Synchronized
    private fun persistPatches() {
        preferences.edit { putString(KEY_PATCHES, json.encodeToString(patches.toMap())) }
    }

    private companion object {
        const val PREFERENCES = "localis_server_state"
        const val KEY_PROGRESS = "playback_progress"
        const val KEY_PATCHES = "media_patches"
    }
}

private class AndroidAssetBackend(context: Context) : StaticAssetBackend {
    private val assets: AssetManager = context.assets
    private val entries: Map<String, AssetEntry> = indexAssets(WEB_ROOT)

    override fun open(path: String): StaticAsset? {
        val normalized = path.trimStart('/').ifEmpty { INDEX_FILE }
        val entry = entries[normalized] ?: return null
        return StaticAsset(
            length = entry.length,
            contentType = contentType(normalized),
            etag = "android-${BuildConfig.VERSION_CODE}-${entry.length}-${normalized.hashCode()}",
            cacheControl = if (normalized == INDEX_FILE) "no-cache" else "public, max-age=3600",
            open = { assets.open("$WEB_ROOT/$normalized", AssetManager.ACCESS_STREAMING) },
        )
    }

    private fun indexAssets(root: String): Map<String, AssetEntry> {
        val result = linkedMapOf<String, AssetEntry>()
        fun walk(relative: String) {
            val fullPath = listOf(root, relative).filter(String::isNotEmpty).joinToString("/")
            val children = assets.list(fullPath).orEmpty()
            if (children.isNotEmpty()) {
                children.forEach { child ->
                    walk(listOf(relative, child).filter(String::isNotEmpty).joinToString("/"))
                }
                return
            }
            if (relative.isEmpty()) return
            val length = runCatching { assets.openFd(fullPath).use { it.length } }
                .getOrElse {
                    assets.open(fullPath, AssetManager.ACCESS_STREAMING).use { stream ->
                        var total = 0L
                        val buffer = ByteArray(32 * 1024)
                        while (true) {
                            val read = stream.read(buffer)
                            if (read < 0) break
                            total += read
                        }
                        total
                    }
                }
            result[relative] = AssetEntry(length)
        }
        walk("")
        return result
    }

    private fun contentType(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html; charset=utf-8"
        "js" -> "text/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "json", "map" -> "application/json; charset=utf-8"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "wasm" -> "application/wasm"
        else -> "application/octet-stream"
    }

    private data class AssetEntry(val length: Long)

    private companion object {
        const val WEB_ROOT = "web"
        const val INDEX_FILE = "index.html"
    }
}
