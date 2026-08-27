plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

fun buildConfigString(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val localisCommitSha = System.getenv("LOCALIS_COMMIT_SHA")
    ?.trim()
    ?.takeIf { it.matches(Regex("^[0-9a-fA-F]{40}$")) }
    ?.lowercase()
    ?: "unknown"
val localisCommitShortSha = localisCommitSha.takeIf { it != "unknown" }?.take(12) ?: "unknown"
val localisBuildTime = System.getenv("LOCALIS_BUILD_TIME")?.trim()?.take(64)?.ifEmpty { null } ?: "unknown"
val localisBuildChannel = System.getenv("LOCALIS_BUILD_CHANNEL")?.trim()?.take(32)?.ifEmpty { null } ?: "local"
val localisBuildDirty = System.getenv("LOCALIS_BUILD_DIRTY") == "1"

android {
    namespace = "com.localis.xrserver"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.localis.xrserver"
        minSdk = 26
        targetSdk = 36
        versionCode = 2
        versionName = "0.2.0-beta01"

        buildConfigField("String", "LOCALIS_COMMIT_SHA", buildConfigString(localisCommitSha))
        buildConfigField("String", "LOCALIS_COMMIT_SHORT_SHA", buildConfigString(localisCommitShortSha))
        buildConfigField("String", "LOCALIS_BUILD_TIME", buildConfigString(localisBuildTime))
        buildConfigField("String", "LOCALIS_BUILD_CHANNEL", buildConfigString(localisBuildChannel))
        buildConfigField("boolean", "LOCALIS_BUILD_DIRTY", localisBuildDirty.toString())

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        create("beta") {
            initWith(getByName("release"))
            isDebuggable = false
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release", "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
    androidResources {
        noCompress += listOf("html", "js", "css", "json", "svg", "wasm")
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.06.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
