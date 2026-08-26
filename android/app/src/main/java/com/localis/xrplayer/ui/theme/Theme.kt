package com.localis.xrplayer.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LocalisColors = darkColorScheme(
    primary = Color(0xFF9B87F5),
    onPrimary = Color(0xFF120B2E),
    secondary = Color(0xFF22D3EE),
    background = Color(0xFF070A12),
    surface = Color(0xFF101522),
    surfaceVariant = Color(0xFF1B2232),
    onBackground = Color(0xFFF4F6FB),
    onSurface = Color(0xFFF4F6FB),
    error = Color(0xFFFF8A80),
)

@Composable
fun LocalisTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = LocalisColors, content = content)
}
