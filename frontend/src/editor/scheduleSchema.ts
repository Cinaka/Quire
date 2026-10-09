import Placeholder from "@tiptap/extension-placeholder"
import StarterKit from "@tiptap/starter-kit"

/** 独立文本schema；不导入日记图片节点、上传器或日记元信息。 */
export function buildScheduleExtensions() {
  return [StarterKit.configure({ heading: { levels: [1, 2, 3] }, horizontalRule: false }),
    Placeholder.configure({ placeholder: "留一简，待来日刻成" })]
}
