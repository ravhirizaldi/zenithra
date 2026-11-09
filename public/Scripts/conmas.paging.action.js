function fConMasPageSubmitAction(actionTypeName) {
    $("#ActionCommonType").val(actionTypeName);
    $("#conmasPageForm").trigger('submit');
    return false;
};
function fConMasPageAction(pageIndex, actionTypeName) {
    $("#PageData_PageIndex").val(pageIndex);
    $("#ActionCommonType").val(actionTypeName);
    $("#conmasPageForm").trigger('submit');
    return false;
}

