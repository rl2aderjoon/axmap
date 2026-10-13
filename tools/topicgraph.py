#!/usr/bin/env python3
"""
토픽 그래프 측정기 — docs/DECISIONS.md 의 D5·D6·D7·D9·D10 근거를 재현한다.

ROS2 처럼 배선이 문자열로 표현되는 코드베이스에서
"어떤 파일이 어떤 파일과 이어져 있고, 시작점에서 몇 단계 떨어져 있는가"를 센다.

    python tools/topicgraph.py <소스루트> [시작파일] [--hub-cap N]

    python tools/topicgraph.py ../e101_hj/redesign/.../ros2_ws/src \\
        bbiyong_base/bbiyong_base/cmd_mux_node.py --hub-cap 6

이것은 제품이 아니라 **측정 도구**다. 정적 문자열만 본다.
그래서 파라미터를 통한 간접 배선을 놓치며, 실제로 놓쳤다 (DECISIONS.md D5).
그 한계를 보여주는 것도 이 스크립트의 역할이다.
"""

import argparse
import collections
import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

TOPIC = re.compile(r'["\'](/[A-Za-z0-9_/]{2,})["\']')


def collect(root):
    """파일별로 등장하는 토픽 문자열을 모은다."""
    files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for name in filenames:
            if not name.endswith(".py"):
                continue
            path = os.path.join(dirpath, name)
            try:
                src = open(path, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            topics = set(TOPIC.findall(src))
            if topics:
                files[os.path.relpath(path, root).replace("\\", "/")] = topics
    return files


def layers_from(topic_files, start, hub_cap=None):
    """
    시작 파일에서 너비우선으로 뻗어나가며 깊이별 파일 집합을 만든다.

    hub_cap 을 주면 그보다 많은 파일이 공유하는 토픽은 엣지에서 제외한다.
    전역 방송 신호(/estop 등)가 무관한 노드들을 서로 1홉 거리로 만드는 것을 막는다.
    """
    adj = collections.defaultdict(set)
    for topic, group in topic_files.items():
        if hub_cap is not None and len(group) > hub_cap:
            continue
        for a in group:
            adj[a] |= group - {a}

    seen, out, frontier = {start}, [], {start}
    while frontier:
        nxt = set()
        for node in frontier:
            nxt |= adj[node] - seen
        if not nxt:
            break
        seen |= nxt
        out.append(nxt)
        frontier = nxt
    return out


def size_histogram(root):
    buckets = [("<100", 0), ("100-300", 0), ("300-600", 0), ("600-1000", 0), ("1000+", 0)]
    counts = dict(buckets)
    total_lines = 0
    biggest = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for name in filenames:
            if not name.endswith(".py"):
                continue
            path = os.path.join(dirpath, name)
            try:
                n = sum(1 for _ in open(path, encoding="utf-8", errors="ignore"))
            except OSError:
                continue
            total_lines += n
            biggest.append((n, os.path.relpath(path, root).replace("\\", "/")))
            key = ("<100" if n < 100 else "100-300" if n < 300 else
                   "300-600" if n < 600 else "600-1000" if n < 1000 else "1000+")
            counts[key] += 1
    biggest.sort(reverse=True)
    return counts, total_lines, biggest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("start", nargs="?")
    ap.add_argument("--hub-cap", type=int, default=6)
    args = ap.parse_args()

    files = collect(args.root)
    topic_files = collections.defaultdict(set)
    for f, topics in files.items():
        for t in topics:
            topic_files[t].add(f)

    counts, total_lines, biggest = size_histogram(args.root)
    n_files = sum(counts.values())

    print(f"== 규모 ==")
    print(f"  {n_files}개 .py, {total_lines:,}줄")
    print(f"  토픽 문자열을 가진 파일 {len(files)}개, 토픽 {len(topic_files)}개\n")

    print("== 크기 분포 ==")
    for label in ["<100", "100-300", "300-600", "600-1000", "1000+"]:
        print(f"  {label:>9}줄  {counts[label]:3}개")
    tail = sum(n for n, _ in biggest[:5])
    if total_lines:
        print(f"  상위 5개 파일이 전체의 {tail / total_lines * 100:.0f}% ({tail:,}줄)")
    for n, f in biggest[:5]:
        print(f"      {n:5}줄  {f}")
    print()

    print(f"== 허브 토픽 (많은 파일이 공유) ==")
    for t, group in sorted(topic_files.items(), key=lambda kv: -len(kv[1]))[:6]:
        flag = "  ← 허브" if len(group) > args.hub_cap else ""
        print(f"  {len(group):3}개 파일  {t}{flag}")
    print()

    if not args.start:
        print("시작 파일을 주면 깊이별 확산을 잽니다.")
        return
    if args.start not in files:
        print(f"시작 파일을 찾을 수 없습니다: {args.start}")
        return

    for cap, label in [(None, "허브 제한 없음"), (args.hub_cap, f"{args.hub_cap}개 초과 토픽 제외")]:
        print(f"== {args.start} 로부터의 깊이 ({label}) ==")
        total = 1
        for depth, group in enumerate(layers_from(topic_files, args.start, cap), 1):
            total += len(group)
            mark = "  ← 요약 한계" if depth == 3 else ""
            print(f"  깊이 {depth}: +{len(group):3}개  (누적 {total:3}){mark}")
        print()


if __name__ == "__main__":
    main()
