package com.localis.xrserver.data

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import android.webkit.MimeTypeMap
import androidx.core.content.edit
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.security.SecureRandom
import java.time.Instant
import java.util.ArrayDeque
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class SafMediaRecord(
    val item: PublicMediaItem,
    val uri: Uri,
    val contentType: String,
    val length: Long,
    val lastModifiedEpochMillis: Long,
    val etag: String,
)

data class MediaFolderState(
    val treeUri: Uri? = null,
    val folderName: String? = null,
    val media: List<SafMediaRecord> = emptyList(),
    val scanning: Boolean = false,
    val truncated: Boolean = false,
    val skippedUnseekable: Int = 0,
    val error: String? = null,
) {
    val mediaCount: Int get() = media.size
}

/**
 * Owns the single user-approved SAF tree used by the Android server.
 *
 * Only seekable documents with a stable, known size enter the public index.
 * This is essential because the browser API promises correct byte ranges and
 * must never emulate a seek by discarding bytes from a pipe.
 */
class SafMediaRepository(context: Context) {
    private val appContext = context.applicationContext
    private val resolver = appContext.contentResolver
    private val preferences = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val scanMutex = Mutex()
    private val idKey by lazy(::loadOrCreateIdKey)

    @Volatile
    private var selectedTree: Uri? = preferences.getString(KEY_TREE_URI, null)?.let(Uri::parse)

    private val _state = MutableStateFlow(MediaFolderState(treeUri = selectedTree))
    val state: StateFlow<MediaFolderState> = _state.asStateFlow()

    fun selectedTreeUri(): Uri? = selectedTree

    fun findMedia(id: String): SafMediaRecord? = _state.value.media.firstOrNull { it.item.id == id }

    suspend fun selectFolder(uri: Uri): MediaFolderState {
        withContext(Dispatchers.IO) {
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val previous = selectedTree
        selectedTree = uri
        preferences.edit { putString(KEY_TREE_URI, uri.toString()) }
        if (previous != null && previous != uri) {
            runCatching {
                resolver.releasePersistableUriPermission(previous, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
        return refresh()
    }

    suspend fun clearFolder() {
        val previous = selectedTree
        selectedTree = null
        preferences.edit { remove(KEY_TREE_URI) }
        _state.value = MediaFolderState()
        if (previous != null) {
            withContext(Dispatchers.IO) {
                runCatching {
                    resolver.releasePersistableUriPermission(previous, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            }
        }
    }

    suspend fun refresh(): MediaFolderState = scanMutex.withLock {
        val tree = selectedTree
        if (tree == null) {
            return@withLock MediaFolderState().also { _state.value = it }
        }
        if (!hasPersistedReadGrant(tree)) {
            val missingGrant = MediaFolderState(
                treeUri = tree,
                error = "文件夹授权已失效，请重新选择媒体文件夹。",
            )
            _state.value = missingGrant
            return@withLock missingGrant
        }

        _state.value = _state.value.copy(scanning = true, error = null)
        val result = try {
            withContext(Dispatchers.IO) { scanTree(tree) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            MediaFolderState(
                treeUri = tree,
                folderName = queryDisplayName(tree),
                error = error.message ?: "扫描媒体文件夹失败。",
            )
        }
        if (selectedTree == tree) _state.value = result
        result
    }

    fun openAt(record: SafMediaRecord, offset: Long): InputStream {
        require(offset in 0..record.length) { "媒体偏移超出范围" }
        val descriptor = resolver.openFileDescriptor(record.uri, "r")
            ?: throw FileNotFoundException("媒体文件不可用")
        try {
            val statSize = descriptor.statSize
            if (statSize >= 0 && statSize != record.length) {
                throw IOException("媒体文件已发生变化，请刷新媒体库")
            }
            Os.lseek(descriptor.fileDescriptor, offset, OsConstants.SEEK_SET)
            return ParcelFileDescriptor.AutoCloseInputStream(descriptor)
        } catch (error: Throwable) {
            runCatching { descriptor.close() }
            throw error
        }
    }

    private fun hasPersistedReadGrant(uri: Uri): Boolean = resolver.persistedUriPermissions.any { permission ->
        permission.uri == uri && permission.isReadPermission
    }

    private suspend fun scanTree(tree: Uri): MediaFolderState {
        val scanGeneration = ByteArray(16).also(SecureRandom()::nextBytes).let { bytes ->
            Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        }
        val rootDocumentId = DocumentsContract.getTreeDocumentId(tree)
        val rootName = queryDisplayName(DocumentsContract.buildDocumentUriUsingTree(tree, rootDocumentId))
            ?: "已选择文件夹"
        val pending = ArrayDeque<PendingDirectory>()
        pending.add(PendingDirectory(rootDocumentId, logicalPath = "", depth = 0))
        val records = mutableListOf<SafMediaRecord>()
        var visitedDirectories = 0
        var skippedUnseekable = 0
        var truncated = false

        while (pending.isNotEmpty()) {
            currentCoroutineContext().ensureActive()
            if (visitedDirectories >= MAX_DIRECTORIES) {
                truncated = true
                break
            }
            val directory = pending.removeFirst()
            visitedDirectories += 1
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, directory.documentId)
            val cursor = try {
                resolver.query(childrenUri, PROJECTION, null, null, null)
            } catch (_: SecurityException) {
                null
            } catch (_: FileNotFoundException) {
                null
            } ?: continue

            cursor.use {
                val idColumn = it.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val nameColumn = it.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val mimeColumn = it.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
                val sizeColumn = it.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
                val modifiedColumn = it.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
                while (it.moveToNext()) {
                    currentCoroutineContext().ensureActive()
                    val documentId = it.getString(idColumn) ?: continue
                    val displayName = sanitizeDisplayName(it.getString(nameColumn) ?: continue)
                    val mimeType = it.getString(mimeColumn).orEmpty()
                    val logicalPath = listOf(directory.logicalPath, displayName)
                        .filter(String::isNotEmpty)
                        .joinToString("/")
                    if (mimeType == DocumentsContract.Document.MIME_TYPE_DIR) {
                        if (directory.depth >= MAX_DEPTH) {
                            truncated = true
                        } else {
                            pending.add(PendingDirectory(documentId, logicalPath, directory.depth + 1))
                        }
                        continue
                    }
                    if (!isVideo(displayName, mimeType)) continue
                    if (records.size >= MAX_MEDIA_FILES) {
                        truncated = true
                        continue
                    }
                    val declaredSize = if (sizeColumn >= 0 && !it.isNull(sizeColumn)) it.getLong(sizeColumn) else -1L
                    if (declaredSize <= 0) {
                        skippedUnseekable += 1
                        continue
                    }
                    val documentUri = DocumentsContract.buildDocumentUriUsingTree(tree, documentId)
                    val verifiedSize = validateSeekable(documentUri, declaredSize)
                    if (verifiedSize == null) {
                        skippedUnseekable += 1
                        continue
                    }
                    val modified = if (modifiedColumn >= 0 && !it.isNull(modifiedColumn)) {
                        it.getLong(modifiedColumn).coerceAtLeast(0L)
                    } else {
                        0L
                    }
                    records += buildRecord(
                        tree = tree,
                        documentId = documentId,
                        uri = documentUri,
                        displayName = displayName,
                        logicalPath = logicalPath,
                        providerMimeType = mimeType,
                        size = verifiedSize,
                        modified = modified,
                        scanGeneration = scanGeneration,
                    )
                }
            }
        }

        return MediaFolderState(
            treeUri = tree,
            folderName = rootName,
            media = records.sortedBy { it.item.relativePath.lowercase() },
            scanning = false,
            truncated = truncated,
            skippedUnseekable = skippedUnseekable,
        )
    }

    private fun validateSeekable(uri: Uri, declaredSize: Long): Long? {
        val signal = CancellationSignal()
        val descriptor = try {
            resolver.openFileDescriptor(uri, "r", signal)
        } catch (_: Throwable) {
            null
        } ?: return null
        return descriptor.use {
            try {
                val statSize = it.statSize
                val size = statSize.takeIf { value -> value > 0 } ?: declaredSize
                if (size <= 0) return@use null
                Os.lseek(it.fileDescriptor, minOf(size - 1, SEEK_PROBE_OFFSET), OsConstants.SEEK_SET)
                Os.lseek(it.fileDescriptor, 0, OsConstants.SEEK_SET)
                size
            } catch (_: Throwable) {
                null
            }
        }
    }

    private fun buildRecord(
        tree: Uri,
        documentId: String,
        uri: Uri,
        displayName: String,
        logicalPath: String,
        providerMimeType: String,
        size: Long,
        modified: Long,
        scanGeneration: String,
    ): SafMediaRecord {
        val id = opaqueId(tree, documentId)
        val metadata = readMetadata(uri)
        val extension = displayName.substringAfterLast('.', "").lowercase()
        val contentType = providerMimeType.takeIf { it.startsWith("video/") }
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
            ?: "application/octet-stream"
        val projection = inferProjection(displayName)
        val stereo = inferStereo(displayName)
        val modifiedAt = Instant.ofEpochMilli(modified).toString()
        val item = PublicMediaItem(
            id = id,
            kind = "video",
            title = displayName.substringBeforeLast('.', displayName),
            fileName = displayName,
            relativePath = logicalPath,
            extension = extension,
            size = size,
            modifiedAt = modifiedAt,
            duration = metadata.durationSeconds,
            width = metadata.width,
            height = metadata.height,
            frameRate = metadata.frameRate,
            projection = projection,
            stereo = stereo,
            directPlay = true,
            compatibilityMode = "direct",
            compatibilityReason = "Android 局域网服务器仅提供原片 Range，实际解码取决于头显浏览器。",
            sourceType = "local",
            streamUrl = "/api/media/$id/stream",
            hlsUrl = null,
        )
        return SafMediaRecord(
            item = item,
            uri = uri,
            contentType = contentType,
            length = size,
            lastModifiedEpochMillis = modified,
            // The HTTP core is responsible for adding RFC 7232 quotes.
            etag = opaqueId(tree, "$scanGeneration:$documentId:$size:$modified"),
        )
    }

    private fun readMetadata(uri: Uri): BasicMediaMetadata = runCatching {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(appContext, uri)
            BasicMediaMetadata(
                durationSeconds = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                    ?.toLongOrNull()?.coerceAtLeast(0L)?.div(1_000.0) ?: 0.0,
                width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
                    ?.toIntOrNull()?.takeIf { it > 0 },
                height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
                    ?.toIntOrNull()?.takeIf { it > 0 },
                frameRate = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)
                    ?.toDoubleOrNull()?.takeIf { it > 0.0 },
            )
        } finally {
            retriever.release()
        }
    }.getOrDefault(BasicMediaMetadata())

    private fun queryDisplayName(uri: Uri): String? = runCatching {
        resolver.query(
            uri,
            arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { cursor ->
            if (!cursor.moveToFirst()) null else cursor.getString(0)
        }
    }.getOrNull()

    private fun opaqueId(tree: Uri, documentId: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(idKey, "HmacSHA256"))
        val digest = mac.doFinal("${tree}\u0000$documentId".toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(digest.copyOf(18), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private fun loadOrCreateIdKey(): ByteArray {
        preferences.getString(KEY_ID_SECRET, null)?.let { encoded ->
            runCatching { Base64.decode(encoded, Base64.NO_WRAP) }
                .getOrNull()
                ?.takeIf { it.size == ID_KEY_BYTES }
                ?.let { return it }
        }
        return ByteArray(ID_KEY_BYTES).also(SecureRandom()::nextBytes).also { generated ->
            preferences.edit(commit = true) {
                putString(KEY_ID_SECRET, Base64.encodeToString(generated, Base64.NO_WRAP))
            }
        }
    }

    private fun inferProjection(fileName: String): String = when {
        VR360_PATTERN.containsMatchIn(fileName) -> "equirect360"
        VR180_PATTERN.containsMatchIn(fileName) -> "equirect180"
        else -> "flat"
    }

    private fun inferStereo(fileName: String): String = when {
        TOP_BOTTOM_PATTERN.containsMatchIn(fileName) -> "tb"
        SIDE_BY_SIDE_PATTERN.containsMatchIn(fileName) -> "sbs"
        else -> "mono"
    }

    private fun isVideo(fileName: String, mimeType: String): Boolean =
        mimeType.startsWith("video/") || fileName.substringAfterLast('.', "").lowercase() in VIDEO_EXTENSIONS

    private fun sanitizeDisplayName(value: String): String = value
        .replace('/', '_')
        .replace('\\', '_')
        .take(MAX_DISPLAY_NAME_CHARS)
        .ifBlank { "未命名媒体" }

    private data class PendingDirectory(val documentId: String, val logicalPath: String, val depth: Int)

    private data class BasicMediaMetadata(
        val durationSeconds: Double = 0.0,
        val width: Int? = null,
        val height: Int? = null,
        val frameRate: Double? = null,
    )

    private companion object {
        const val PREFERENCES = "localis_media_library"
        const val KEY_TREE_URI = "tree_uri"
        const val KEY_ID_SECRET = "opaque_id_secret"
        const val ID_KEY_BYTES = 32
        const val MAX_DEPTH = 12
        const val MAX_DIRECTORIES = 2_000
        const val MAX_MEDIA_FILES = 5_000
        const val MAX_DISPLAY_NAME_CHARS = 240
        const val SEEK_PROBE_OFFSET = 4_096L

        val PROJECTION = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        val VIDEO_EXTENSIONS = setOf("mp4", "m4v", "mov", "webm", "mkv", "avi", "ts", "m2ts")
        val VR180_PATTERN = Regex("(?:^|[^a-z0-9])(?:vr[-_ ]?180|180(?:deg)?)(?:[^a-z0-9]|$)", RegexOption.IGNORE_CASE)
        val VR360_PATTERN = Regex("(?:^|[^a-z0-9])(?:vr[-_ ]?360|360(?:deg)?|equirect)(?:[^a-z0-9]|$)", RegexOption.IGNORE_CASE)
        val SIDE_BY_SIDE_PATTERN = Regex("(?:^|[^a-z0-9])(?:sbs|hsbs|side[-_ ]?by[-_ ]?side|left[-_ ]?right|lr)(?:[^a-z0-9]|$)", RegexOption.IGNORE_CASE)
        val TOP_BOTTOM_PATTERN = Regex("(?:^|[^a-z0-9])(?:tb|htb|top[-_ ]?bottom|over[-_ ]?under|ou)(?:[^a-z0-9]|$)", RegexOption.IGNORE_CASE)
    }
}
