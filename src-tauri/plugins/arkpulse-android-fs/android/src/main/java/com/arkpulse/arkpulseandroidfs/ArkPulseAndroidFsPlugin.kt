package com.arkpulse.arkpulseandroidfs

import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.DialogInterface
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.view.WindowManager
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// 安卓原生桥接：MediaStore 落盘 / SAF 持久目录 / 完成确认弹窗 / 亮屏保活。
// 命令名（snake_case）须与 Rust 侧 generate_handler! 及前端 invoke 完全一致。
@TauriPlugin
class ArkPulseAndroidFsPlugin(private val activity: Activity) : Plugin(activity) {

    // L1：向 MediaStore.Downloads 插入文件，固定落到 Download/ArkPulse。零权限零弹框。
    @Command
    fun mediastore_insert(invoke: Invoke) {
        val name = invoke.getArgs().getString("name")
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            invoke.reject("需要 Android 10 及以上")
            return
        }
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.RELATIVE_PATH, "Download/ArkPulse")
            put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        if (uri == null) {
            invoke.reject("MediaStore 插入失败：存储不可用或被拒绝")
            return
        }
        val ret = JSObject()
        ret.put("uri", uri.toString())
        invoke.resolve(ret)
    }

    // L3：对 SAF 树 URI 取得持久化授权（重启后仍可写），权限存入系统。
    @Command
    fun saf_take_permission(invoke: Invoke) {
        val treeUri = Uri.parse(invoke.getArgs().getString("tree_uri"))
        try {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            activity.contentResolver.takePersistableUriPermission(treeUri, flags)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("无法持久化 SAF 授权：${e.message}")
        }
    }

    // L3：在已授权树目录下创建子文档，返回可直接流式写入的 content URI（无需再次弹框）。
    @Command
    fun saf_create_child(invoke: Invoke) {
        val treeUri = Uri.parse(invoke.getArgs().getString("tree_uri"))
        val name = invoke.getArgs().getString("name")
        try {
            val docUri = DocumentsContract.buildDocumentUriUsingTree(
                treeUri,
                DocumentsContract.getTreeDocumentId(treeUri)
            )
            val childUri = DocumentsContract.createDocument(
                activity.contentResolver,
                docUri,
                "application/octet-stream",
                name
            )
            if (childUri == null) {
                invoke.reject("SAF 创建子文件失败")
                return
            }
            val ret = JSObject()
            ret.put("uri", childUri.toString())
            invoke.resolve(ret)
        } catch (e: Exception) {
            invoke.reject("SAF 创建子文件失败：${e.message}")
        }
    }

    // 下载完成确认弹窗：原生 AlertDialog + 单「确定」按钮，点确定才 resolve（不自动消失）。
    @Command
    fun show_save_dialog(invoke: Invoke) {
        val title = invoke.getArgs().getString("title")
        val message = invoke.getArgs().getString("message")
        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setTitle(title)
                .setMessage(message)
                .setCancelable(false)
                .setPositiveButton("确定") { _: DialogInterface?, _: Int -> invoke.resolve() }
                .show()
        }
    }

    // 下载期间亮屏保活：对当前 Activity 窗口加/清 FLAG_KEEP_SCREEN_ON（不阻止手动锁屏）。
    @Command
    fun set_keep_screen_on(invoke: Invoke) {
        val enabled = invoke.getArgs().getBoolean("enabled")
        activity.runOnUiThread {
            val window = activity.window
            if (enabled) {
                window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        invoke.resolve()
    }
}
