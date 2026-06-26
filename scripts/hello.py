#!/usr/bin/env python3
"""Простой демонстрационный скрипт."""

import random


def fibonacci(n: int) -> list[int]:
    """Вернуть первые n чисел Фибоначчи."""
    seq = [0, 1]
    for _ in range(n - 2):
        seq.append(seq[-1] + seq[-2])
    return seq[:n]


def main() -> None:
    print("Привет! Это пример Python-скрипта.")
    print(f"Первые 10 чисел Фибоначчи: {fibonacci(10)}")
    print(f"Случайное число от 1 до 100: {random.randint(1, 100)}")


if __name__ == "__main__":
    main()
