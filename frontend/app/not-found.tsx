import { AppStatusPage } from "@/components/app-status-page";

export default function NotFound() {
  return (
    <AppStatusPage
      title="ページが見つかりません"
      description="ページが移動したか、会議が削除された可能性があります。ホームからもう一度開いてください。"
    />
  );
}
