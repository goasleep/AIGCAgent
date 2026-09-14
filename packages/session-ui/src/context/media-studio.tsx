import { createContext, useContext, type ParentProps } from "solid-js"

export type MediaRegenerateRequest = {
  /** 媒体库资产 id（从附件 url 解析） */
  assetID: string
  /** 资产的项目相对路径（由 app 侧 resolveAsset 解析） */
  path: string
  /** 选段起点（秒） */
  start: number
  /** 选段终点（秒） */
  end: number
  /** 用户描述的重生成效果 */
  prompt: string
}

export type MediaStudio = {
  /** 把资产 id 解析为可播放的内容 URL（带 directory 与服务器基址） */
  contentUrl?: (assetID: string) => string
  /** 将会话中的媒体库相对 URL 解析为当前服务器地址 */
  resolveUrl?: (url: string) => string
  /** 读取需要鉴权的媒体 URL，并返回可供 img/video 使用的 URL */
  loadUrl?: (url: string) => Promise<string>
  /** 查询资产信息（项目相对路径等），供重生成指令引用 */
  resolveAsset?: (assetID: string) => Promise<{ path: string } | undefined>
  /** 提交选段重生成请求（app 侧实现：填入 prompt 输入框） */
  regenerate?: (request: MediaRegenerateRequest) => void
}

// 默认空实现：未挂载 provider 的环境（storybook、测试）里视频退化为普通播放器
const Context = createContext<MediaStudio>({})

export function MediaStudioProvider(props: ParentProps<MediaStudio>) {
  const value: MediaStudio = {
    get contentUrl() {
      return props.contentUrl
    },
    get resolveUrl() {
      return props.resolveUrl
    },
    get loadUrl() {
      return props.loadUrl
    },
    get resolveAsset() {
      return props.resolveAsset
    },
    get regenerate() {
      return props.regenerate
    },
  }
  return <Context.Provider value={value}>{props.children}</Context.Provider>
}

export function useMediaStudio() {
  return useContext(Context)
}
