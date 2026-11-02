import UIKit

/// Memory + disk cached image loading with request de-duplication.
actor ImageLoader {
    static let shared = ImageLoader()

    private let memory = NSCache<NSURL, UIImage>()
    private var inflight: [URL: Task<UIImage?, Never>] = [:]
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("card-images")
        config.urlCache = URLCache(memoryCapacity: 24 << 20, diskCapacity: 400 << 20, directory: dir)
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.timeoutIntervalForRequest = 20
        session = URLSession(configuration: config)
        memory.countLimit = 400
    }

    nonisolated func cached(_ url: URL) -> UIImage? {
        memory.object(forKey: url as NSURL)
    }

    func image(for url: URL) async -> UIImage? {
        if let hit = memory.object(forKey: url as NSURL) { return hit }
        if let task = inflight[url] { return await task.value }
        let session = self.session
        let task = Task<UIImage?, Never> {
            guard let result = (try? await session.data(from: url)) else { return nil }
            let (data, response) = result
            guard ((response as? HTTPURLResponse)?.statusCode ?? 200) < 400, let image = UIImage(data: data) else { return nil }
            return image.preparingForDisplay() ?? image
        }
        inflight[url] = task
        let image = await task.value
        inflight[url] = nil
        if let image { memory.setObject(image, forKey: url as NSURL) }
        return image
    }
}
