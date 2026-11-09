$(function () {
    if ($.cookie("ConMasManagerCookie_SideState") == "0") {
        fConMasSideUp();
    }
});
function fConMasOnSideButton() {
    if ($("#ConMasSideButton").val() == "<") {
        fConMasSideUp();
        fConMasSaveSideStateCookie(0);
    }
    else {
        fConMasSideDown();
        fConMasSaveSideStateCookie(1);
    }
};
function fConMasSideUp() {
    $('#SideWrap').slideUp(); $('#SideWrap').width(0); $('#MainWrap').css('margin-left', $('#SideWrap').width());
    $("#ConMasSideButton").val(">");
    $("#ConMasSideButtonDiv").css("left", "0px");
};
function fConMasSideDown() {
    $('#SideWrap').slideDown(); $('#SideWrap').width(270); $('#MainWrap').css('margin-left', $('#SideWrap').width());
    $("#ConMasSideButton").val("<");
    $("#ConMasSideButtonDiv").css("left", "255px");
};
function fConMasSaveSideStateCookie(value) {
    $.cookie("ConMasManagerCookie_SideState", value, { expires: 7 });
};