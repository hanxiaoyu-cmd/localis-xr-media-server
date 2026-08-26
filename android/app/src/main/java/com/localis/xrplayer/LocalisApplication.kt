package com.localis.xrplayer

import android.app.Application
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import com.localis.xrplayer.data.LocalisApi
import com.localis.xrplayer.data.OriginInterceptor
import com.localis.xrplayer.data.PlaybackPathPolicyInterceptor
import com.localis.xrplayer.data.PersistentCookieJar
import com.localis.xrplayer.data.PreferencesCookiePersistence
import com.localis.xrplayer.data.PreferencesServerOriginStore
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

class LocalisApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}

class AppContainer(application: Application) {
    private val originStore = PreferencesServerOriginStore(application)
    private val cookieJar = PersistentCookieJar(PreferencesCookiePersistence(application))

    val httpClient: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .addInterceptor(OriginInterceptor(originStore::get))
        .addInterceptor(PlaybackPathPolicyInterceptor(originStore::get))
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    val api = LocalisApi(httpClient, originStore)

    val mediaDataSourceFactory: DataSource.Factory = OkHttpDataSource.Factory(httpClient)
        .setUserAgent("Localis-Android/${BuildConfig.VERSION_NAME}")
}
