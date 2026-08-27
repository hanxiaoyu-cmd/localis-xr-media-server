package com.localis.xrserver

import android.app.Application
import com.localis.xrserver.data.SafMediaRepository
import com.localis.xrserver.data.SafMediaServerBackend
import com.localis.xrserver.service.ServerRuntimeStore
import com.localis.xrserver.service.ServerSettingsStore

class LocalisApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}

class AppContainer(application: Application) {
    val mediaRepository = SafMediaRepository(application)
    val mediaBackend = SafMediaServerBackend(application, mediaRepository)
    val serverRuntime = ServerRuntimeStore()
    val serverSettings = ServerSettingsStore(application)
}
