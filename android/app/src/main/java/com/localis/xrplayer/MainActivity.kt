package com.localis.xrplayer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.localis.xrplayer.ui.LocalisApp
import com.localis.xrplayer.ui.MainViewModel
import com.localis.xrplayer.ui.theme.LocalisTheme

class MainActivity : ComponentActivity() {
    private val container by lazy { (application as LocalisApplication).container }
    private val viewModel by viewModels<MainViewModel> { MainViewModel.Factory(container.api) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            LocalisTheme {
                LocalisApp(
                    viewModel = viewModel,
                    mediaDataSourceFactory = container.mediaDataSourceFactory,
                )
            }
        }
    }
}
