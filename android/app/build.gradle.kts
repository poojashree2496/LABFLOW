plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "edu.karunya.labflow"
    compileSdk = 35
    defaultConfig {
        applicationId = "edu.karunya.labflow"
        minSdk = 30 // Android 11: framework BiometricPrompt with BIOMETRIC_STRONG and per-use Keystore keys
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        // The live LABFLOW API and site. Both can be changed in the app (Server settings), for a test server on the LAN.
        buildConfigField("String", "API_URL", "\"https://script.google.com/macros/s/AKfycbz6bQX3K7sMwWQQGmzO0T58eh1kF-rSSWTePAM7TJm47x7YcoiGh-UMfPYd4TUCc6VHMg/exec\"")
        buildConfigField("String", "WEB_URL", "\"https://labflow-blue.vercel.app/\"")
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // Free Google Play services libraries; no account, key or console needed.
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}

dependencies { testImplementation("junit:junit:4.13.2") }
