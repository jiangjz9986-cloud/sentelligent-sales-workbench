"""Public tender-source adapters."""

from .base import SourceAdapter, SourceResult
from .binzhou import BinzhouAdapter
from .dongying import DongyingAdapter
from .jining import JiningAdapter
from .hospital_html import HospitalHtmlAdapter
from .jiaozhou_central_hospital import JiaozhouCentralHospitalAdapter, QdjzchAdapter
from .qingdao import QingdaoAdapter

__all__ = [
    "BinzhouAdapter",
    "DongyingAdapter",
    "JiningAdapter",
    "HospitalHtmlAdapter",
    "JiaozhouCentralHospitalAdapter",
    "QdjzchAdapter",
    "QingdaoAdapter",
    "SourceAdapter",
    "SourceResult",
]
