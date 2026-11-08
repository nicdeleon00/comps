import Foundation

/// Keeps the details of a crash so the next launch can show them, to be sent and fixed.
/// Best effort: written from the crash itself, so it may occasionally miss one.
enum CrashLog {
    private static let url = URL.cachesDirectory.appending(path: "last-crash.txt")

    /// The last crash's details, read once at launch (and then cleared).
    static let last: String? = {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        try? FileManager.default.removeItem(at: url)
        return text
    }()

    static func install() {
        _ = last
        NSSetUncaughtExceptionHandler { e in
            CrashLog.write("Exception \(e.name.rawValue): \(e.reason ?? "")\n" + e.callStackSymbols.joined(separator: "\n"))
        }
        for sig in [SIGABRT, SIGILL, SIGSEGV, SIGBUS, SIGTRAP, SIGFPE] {
            signal(sig) { s in
                CrashLog.write("Signal \(s)\n" + Thread.callStackSymbols.joined(separator: "\n"))
                signal(s, SIG_DFL)
                raise(s)
            }
        }
    }

    private static func write(_ details: String) {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let text = "Comps \(version), \(ProcessInfo.processInfo.operatingSystemVersionString), \(Date())\n\(details)"
        try? text.write(to: url, atomically: false, encoding: .utf8)
    }
}
