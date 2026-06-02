#!/usr/bin/env python3
"""
验证 todo 扩展的完成提醒注入、完成后2轮保留再移除的逻辑。

分析 ~/.pi/agent/sessions/ 下的所有 session JSONL 文件，
统计：
1. todo 工具调用次数（add/update/delete/clear）
2. 是否有 todo-auto-clear / todo-verification-nudge / todo-reminder 消息注入
3. 所有 todo 完成后是否在 2 轮后自动清空
"""

import json
import os
from pathlib import Path
from collections import defaultdict
from typing import Optional

def analyze_session(session_path: str) -> dict:
    """分析单个 session 文件"""
    result = {
        'path': session_path,
        'todo_tool_calls': 0,
        'todo_adds': 0,
        'todo_updates': 0,
        'todo_deletes': 0,
        'todo_clears': 0,
        'completed_todos': [],
        'auto_clear_messages': [],
        'verification_nudge_messages': [],
        'reminder_messages': [],
        'all_todos_at_end': [],
        'session_length': 0,
    }
    
    try:
        with open(session_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        result['session_length'] = len(lines)
        
        for i, line in enumerate(lines, 1):
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            
            if entry.get('type') != 'message':
                continue
            
            msg = entry.get('message', {})
            
            # 检查 todo 工具调用
            if msg.get('role') == 'toolResult' and msg.get('toolName') == 'todo':
                details = msg.get('details', {})
                action = details.get('action')
                todos = details.get('todos', [])
                
                result['todo_tool_calls'] += 1
                
                if action == 'add':
                    result['todo_adds'] += 1
                elif action == 'update':
                    result['todo_updates'] += 1
                    # 记录完成的 todo
                    for t in todos:
                        if t.get('status') == 'completed':
                            result['completed_todos'].append({
                                'line': i,
                                'id': t.get('id'),
                                'text': t.get('text'),
                            })
                elif action == 'delete':
                    result['todo_deletes'] += 1
                elif action == 'clear':
                    result['todo_clears'] += 1
                
                # 记录最后的 todo 状态
                if i == len(lines):
                    result['all_todos_at_end'] = todos
            
            # 检查注入的消息
            content = msg.get('content', '')
            if isinstance(content, str):
                if 'todo-auto-clear' in content:
                    result['auto_clear_messages'].append({'line': i, 'content': content[:200]})
                elif 'todo-verification-nudge' in content:
                    result['verification_nudge_messages'].append({'line': i, 'content': content[:200]})
                elif 'todo-reminder' in content:
                    result['reminder_messages'].append({'line': i, 'content': content[:200]})
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        text = str(item.get('text', ''))
                        if 'todo-auto-clear' in text:
                            result['auto_clear_messages'].append({'line': i, 'content': text[:200]})
                        elif 'todo-verification-nudge' in text:
                            result['verification_nudge_messages'].append({'line': i, 'content': text[:200]})
                        elif 'todo-reminder' in text:
                            result['reminder_messages'].append({'line': i, 'content': text[:200]})
    
    except Exception as e:
        result['error'] = str(e)
    
    return result

def find_session_files(pi_dir: str = None) -> list:
    """查找所有 session JSONL 文件"""
    if pi_dir is None:
        pi_dir = os.path.expanduser('~/.pi/agent/sessions')
    
    session_files = []
    
    # 遍历所有子目录
    for root, dirs, files in os.walk(pi_dir):
        for f in files:
            if f.endswith('.jsonl'):
                session_files.append(os.path.join(root, f))
    
    return sorted(session_files)

def main():
    print("=" * 70)
    print("Todo 扩展完成提醒注入验证脚本")
    print("=" * 70)
    print()
    
    # 查找 session 文件
    session_files = find_session_files()
    print(f"找到 {len(session_files)} 个 session 文件")
    print()
    
    # 统计
    total_stats = {
        'total_sessions': len(session_files),
        'sessions_with_todo': 0,
        'total_todo_calls': 0,
        'total_auto_clear': 0,
        'total_verification_nudge': 0,
        'total_reminder': 0,
        'sessions_with_completed': 0,
    }
    
    sessions_with_injection = []
    
    for session_path in session_files:
        result = analyze_session(session_path)
        
        if result['todo_tool_calls'] > 0:
            total_stats['sessions_with_todo'] += 1
            total_stats['total_todo_calls'] += result['todo_tool_calls']
        
        if result['completed_todos']:
            total_stats['sessions_with_completed'] += 1
        
        if result['auto_clear_messages']:
            total_stats['total_auto_clear'] += len(result['auto_clear_messages'])
            sessions_with_injection.append(('auto-clear', session_path, result['auto_clear_messages']))
        
        if result['verification_nudge_messages']:
            total_stats['total_verification_nudge'] += len(result['verification_nudge_messages'])
            sessions_with_injection.append(('verification-nudge', session_path, result['verification_nudge_messages']))
        
        if result['reminder_messages']:
            total_stats['total_reminder'] += len(result['reminder_messages'])
            sessions_with_injection.append(('reminder', session_path, result['reminder_messages']))
        
        # 只显示有 todo 操作的 session
        if result['todo_tool_calls'] > 0:
            session_id = os.path.basename(session_path)[:20]
            print(f"Session: {session_id}...")
            print(f"  Todo 工具调用: {result['todo_tool_calls']} 次")
            print(f"  - add: {result['todo_adds']}, update: {result['todo_updates']}, delete: {result['todo_deletes']}, clear: {result['todo_clears']}")
            print(f"  完成的 todo: {len(result['completed_todos'])} 个")
            for t in result['completed_todos'][:3]:
                print(f"    #{t['id']}: {t['text'][:50]}")
            if len(result['completed_todos']) > 3:
                print(f"    ... 还有 {len(result['completed_todos']) - 3} 个")
            
            if result['auto_clear_messages']:
                print(f"  ★ auto-clear 注入: {len(result['auto_clear_messages'])} 次")
            if result['verification_nudge_messages']:
                print(f"  ★ verification-nudge 注入: {len(result['verification_nudge_messages'])} 次")
            if result['reminder_messages']:
                print(f"  ★ reminder 注入: {len(result['reminder_messages'])} 次")
            print()
    
    print("=" * 70)
    print("汇总统计")
    print("=" * 70)
    print(f"总 session 数: {total_stats['total_sessions']}")
    print(f"使用了 todo 的 session: {total_stats['sessions_with_todo']}")
    print(f"有 todo 完成的 session: {total_stats['sessions_with_completed']}")
    print()
    print("注入消息统计:")
    print(f"  todo-auto-clear (完成后2轮清空): {total_stats['total_auto_clear']} 次")
    print(f"  todo-verification-nudge (3+完成无验证): {total_stats['total_verification_nudge']} 次")
    print(f"  todo-reminder (10轮未调用): {total_stats['total_reminder']} 次")
    
    if sessions_with_injection:
        print()
        print("=" * 70)
        print("有注入消息的 session")
        print("=" * 70)
        for inject_type, path, messages in sessions_with_injection:
            session_id = os.path.basename(path)[:30]
            print(f"[{inject_type}] {session_id}")
            for msg in messages[:2]:
                print(f"  Line {msg['line']}: {msg['content'][:100]}...")
    else:
        print()
        print("⚠️  没有找到任何注入消息！")
        print("可能原因:")
        print("  1. 所有 session 都没有完成所有 todo")
        print("  2. todo 扩展没有正确加载")
        print("  3. before_agent_start 事件没有被触发")
    
    print()
    print("=" * 70)
    print("结论")
    print("=" * 70)
    
    if total_stats['total_auto_clear'] == 0 and total_stats['total_verification_nudge'] == 0 and total_stats['total_reminder'] == 0:
        print("❌ 未检测到任何 todo 注入消息")
        print()
        print("可能的解释:")
        print("1. 这些 session 中没有触发条件:")
        print("   - auto-clear: 需要所有 todo 完成后等待 2 轮用户消息")
        print("   - verification-nudge: 需要完成 3+ 个 todo 且无验证步骤")
        print("   - reminder: 需要 10 轮未调用 todo 工具")
        print()
        print("2. 需要在实际使用中测试这些功能")
    else:
        print(f"✅ 检测到注入消息:")
        print(f"   - auto-clear: {total_stats['total_auto_clear']} 次")
        print(f"   - verification-nudge: {total_stats['total_verification_nudge']} 次")
        print(f"   - reminder: {total_stats['total_reminder']} 次")

if __name__ == '__main__':
    main()
