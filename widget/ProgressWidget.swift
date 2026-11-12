// Progress Widget: a floating, always-on-top window that shows every Claude
// session's progress. The progress-panel mod writes one JSON file per session
// to ~/.claude/progress-panel/sessions/; this window reads them all every
// 1.5 s and hands them to dashboard.html.
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var panel: NSPanel!
    private var web: WKWebView!
    private var timer: Timer?
    private var lastPayload = ""
    private var isReady = false
    private let dir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/progress-panel/sessions")
    // Sessions silent for longer than this drop off the board.
    private let window: TimeInterval = 12 * 3600

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 0, y: 0, width: 400, height: 640)
        panel = NSPanel(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.title = "진행 경과"
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = NSColor(red: 0.03, green: 0.05, blue: 0.10, alpha: 0.94)
        panel.minSize = NSSize(width: 300, height: 260)
        panel.setFrameAutosaveName("ProgressWidget")
        if !panel.setFrameUsingName("ProgressWidget"), let screen = NSScreen.main {
            let v = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: v.maxX - frame.width - 24, y: v.maxY - frame.height - 24))
        }

        web = WKWebView(frame: frame, configuration: WKWebViewConfiguration())
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        panel.contentView = web
        if let html = Bundle.main.url(forResource: "dashboard", withExtension: "html") {
            web.loadFileURL(html, allowingReadAccessTo: html.deletingLastPathComponent())
        }
        panel.orderFrontRegardless()

        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isReady = true
        lastPayload = ""
        refresh()
    }

    private func refresh() {
        guard isReady else { return }
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        let files = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: keys)) ?? []
        let cutoff = Date().addingTimeInterval(-window)
        var items: [String] = []
        for file in files where file.pathExtension == "json" {
            let modified = (try? file.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? .distantPast
            guard modified > cutoff,
                  let data = try? Data(contentsOf: file),
                  (try? JSONSerialization.jsonObject(with: data)) != nil,
                  let text = String(data: data, encoding: .utf8)
            else { continue }
            items.append(text)
        }
        let payload = "[" + items.joined(separator: ",") + "]"
        guard payload != lastPayload else { return }
        lastPayload = payload
        web.evaluateJavaScript("window.render(\(payload))")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
