import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page-main">
      <h1>このページは出していません</h1>
      <p>タブが隠れているか、まだありません。</p>
      <p>
        <Link href="/home">ホームへ戻る</Link>
      </p>
    </main>
  );
}
