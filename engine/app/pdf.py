"""PDF 문서: 글자를 뽑고 페이지 단위로 조각낸다.

- 글자는 pypdf로 뽑는다 (2026-11-12 결정). 제목·표 구조는 없고 글자만 나온다. 스캔본(글자 없는 PDF)은 읽지 못한다.
  pypdf 사용법: https://pypdf.readthedocs.io/en/stable/user/extract-text.html (PdfReader, page.extract_text)
- 뽑은 글은 페이지마다 PAGE_BREAK(폼 피드, \\f)로 이어 documents.content에 넣는다.
  그래서 원문만 보고도 PDF인지(페이지로 나뉜 글인지) 알 수 있고, 다른 색인을 만들 때도 같은 페이지로 다시 자를 수 있다.
- 조각 단위는 페이지다 (2026-11-12 사용자 결정). 근거 위치는 [문서 제목, "p.3"]으로 남는다. 빈 페이지는 조각을 만들지 않는다.
- 원본 PDF는 Git 프로젝트면 저장소에, 직접 관리 프로젝트면 DB(document_files)에 있다.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass

PAGE_BREAK = "\f"
MAX_BYTES = 20 * 1024 * 1024   # PDF 하나의 크기 한도 (웹 프록시도 PDF 올리기 경로만 이만큼 받는다)


class PdfError(ValueError):
    """사람에게 보여 줄 PDF 오류 (암호, 깨진 파일, 글자 없음 등)."""


@dataclass
class PdfText:
    content: str          # 페이지마다 PAGE_BREAK로 이은 글
    pages: int            # 전체 페이지 수
    empty_pages: int      # 글자가 없는 페이지 수 (그림만 있는 페이지 등)
    odd_ratio: float      # 흔한 글자(한글·영문·숫자·문장부호·한자·가나)가 아닌 글자의 비율. 높으면 글자가 깨졌을 수 있다


def is_pdf_name(name: str) -> bool:
    return name.lower().endswith(".pdf")


def is_paged(text: str) -> bool:
    return PAGE_BREAK in text


# 한 페이지의 글을 다듬는다: 줄 끝 공백, 3줄 이상 빈 줄을 줄인다. 페이지 구분 기호가 글 안에 있으면 줄바꿈으로 바꾼다.
# 제어 문자는 공백으로 바꾼다 (Chrome으로 만든 PDF는 띄어쓰기가 \x01로 나오기도 한다).
def _clean(text: str) -> str:
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", " ", text.replace(PAGE_BREAK, "\n"))
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = "\n".join(line.rstrip() for line in text.splitlines())
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract(data: bytes) -> PdfText:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError, PyPdfError

    if len(data) > MAX_BYTES:
        raise PdfError(f"{MAX_BYTES // (1024 * 1024)}MB보다 커요")
    if not data.startswith(b"%PDF-"):
        raise PdfError("PDF 파일이 아니에요")
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):   # 열람 암호가 없는 '권한만 잠긴' PDF는 빈 암호로 열린다
            raise PdfError("암호가 걸린 PDF는 읽을 수 없어요")
        pages = [_clean(p.extract_text() or "") for p in reader.pages]
    except PdfError:
        raise
    except (PdfReadError, PyPdfError, ValueError, KeyError, TypeError) as e:
        raise PdfError(f"PDF를 읽을 수 없어요 ({type(e).__name__})") from None
    if not pages:
        raise PdfError("페이지가 없는 PDF예요")
    if not any(pages):
        raise PdfError("글자가 없는 PDF예요. 스캔한 PDF는 아직 읽지 못해요 (OCR 미지원)")
    # 제목은 파일 이름으로 정한다. PDF 정보의 제목은 "Microsoft Word - 초안.docx"처럼 엉뚱한 경우가 많다.
    content = PAGE_BREAK.join(pages)
    return PdfText(content, len(pages), sum(1 for p in pages if not p), odd_ratio(content))


# 글꼴에 글자 대응표(ToUnicode)가 없는 PDF는 한글이 엉뚱한 문자(구르무키 문자 등)로 뽑힌다. 막지는 않고 비율만 알려 준다.
COMMON = re.compile(r"[\s\w\x21-\x7e\u00a0-\u024f\u2000-\u206f\u2190-\u25ff\u3000-\u30ff\u3130-\u318f"
                    r"\u4e00-\u9fff\uac00-\ud7a3\uff00-\uffef]")
SUSPECT_RATIO = 0.2


def odd_ratio(text: str) -> float:
    chars = [c for c in text if not c.isspace()]
    if not chars:
        return 0.0
    odd = sum(1 for c in chars if not COMMON.match(c) or ("\u0900" <= c <= "\u0dff"))   # \w가 받는 인도계 문자는 깨짐으로 본다
    return round(odd / len(chars), 3)


# 페이지 단위 조각: (heading_path, 본문) 목록. 페이지 번호는 1부터. 빈 페이지는 뺀다.
def split_pages(text: str, title: str) -> list[tuple[list[str], str]]:
    return [([title, f"p.{n}"], body.strip()) for n, body in enumerate(text.split(PAGE_BREAK), 1) if body.strip()]
